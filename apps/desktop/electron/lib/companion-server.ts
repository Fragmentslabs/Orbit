/**
 * Servidor WebSocket para o Orbit Companion.
 * 
 * Roda dentro do processo principal do Electron, expondo uma API segura
 * via WebSocket para que o app mobile possa controlar o desktop pela rede local.
 * 
 * Segurança:
 * - PIN de pareamento (6 dígitos) gerado randomicamente na inicialização
 * - Autenticação obrigatória antes de qualquer operação
 * - Rate limiting no PIN (5 tentativas por minuto)
 * - A credenciais de API (auth.json) NUNCA são transmitidas ao companion
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'http'
import { createServer } from 'http'
import { app, BrowserWindow } from 'electron'
import crypto from 'node:crypto'
import os from 'node:os'
import nodePath from 'node:path'
import { readdir } from 'node:fs/promises'
import type {
  CompanionRequest,
  CompanionEvent,
  WsMessage,
  AuthOkResponse,
  AuthErrorResponse,
  ApiResponse,
  StatusUpdate,
} from '@shared/companion'
import type { ChatEvent, SessionInfo, FolderInfo, ChatMessage, SendMessageInput } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { readJson, writeJson, removeJson, listKeys } from './storage'
import { searchSessions } from './search-sessions'
import { listCredentialProviders } from './auth'
import { reply as askReply } from './ask-broker'
import { revert as revertSession, unrevert as unrevertSession } from './session/revert'
import { abortChat, runChat } from './chat-engine'
import { abortOrchestration, approvePlan, rejectPlan, runOrchestration } from './orchestrator'
import { readPlanFile, deletePlanFile } from './plan-file'
import { getCatalog } from './catalog'
import { getModelsSnapshot } from './models'
import { computeAnalytics } from './analytics'
import {
  list as listMemories,
  update as updateMemory,
  remove as removeMemory,
  promote as promoteMemory,
  getFull as getMemoryFull,
} from './memory/service'
import {
  startCompanionHttpServer,
  stopCompanionHttpServer,
  isCompanionHttpRunning,
  HTTP_PORT as COMPANION_HTTP_PORT,
} from './companion-http'

const PORT = 3847
const PIN_LENGTH = 6
const MAX_PIN_ATTEMPTS = 5
const PIN_WINDOW_MS = 60_000 // 1 minuto
const PIN_TTL_MS = 300_000 // PIN válido por 5 minutos

interface ConnectedClient {
  ws: WebSocket
  authenticated: boolean
  deviceName: string
  connectedAt: number
}

let server: Server | null = null
let wss: WebSocketServer | null = null
let currentPin: string = ''
let pinCreatedAt: number = 0
const pinAttempts = new Map<string, number[]>() // ip → timestamps

// ─── Dispositivos pareados (tokens persistentes) ─────────────────────────────
// O PIN expira em 5 min, então ele serve só para o PRIMEIRO pareamento.
// Ao autenticar com PIN, o desktop emite um token persistente que o app
// guarda e usa nas próximas conexões — é isso que faz a conexão sobreviver
// a restarts do app sem pedir PIN de novo.

const DEVICES_KEY = 'companion/devices'

interface PairedDevice {
  token: string
  deviceName: string
  pairedAt: number
  lastSeenAt: number
}

let pairedDevices: PairedDevice[] | null = null

async function loadDevices(): Promise<PairedDevice[]> {
  if (!pairedDevices) {
    pairedDevices = (await readJson<PairedDevice[]>(DEVICES_KEY)) ?? []
  }
  return pairedDevices
}

async function registerDevice(deviceName: string): Promise<string> {
  const devices = await loadDevices()
  const token = crypto.randomBytes(32).toString('hex')
  devices.push({ token, deviceName, pairedAt: Date.now(), lastSeenAt: Date.now() })
  await writeJson(DEVICES_KEY, devices)
  return token
}

export async function validateDeviceToken(token: string): Promise<boolean> {
  if (!token) return false
  const devices = await loadDevices()
  const device = devices.find((d) => {
    // Comparação em tempo constante (tokens têm tamanho fixo de 64 hex chars)
    if (d.token.length !== token.length) return false
    return crypto.timingSafeEqual(Buffer.from(d.token), Buffer.from(token))
  })
  if (!device) return false
  device.lastSeenAt = Date.now()
  void writeJson(DEVICES_KEY, devices)
  return true
}
// Modo de pareamento: ativo enquanto o modal "Conectar App" está aberto no
// desktop. Enquanto ativo, o PIN atual é exposto pelo endpoint público de
// descoberta (/api/ping), permitindo que o app conecte com um toque ao achar
// o desktop na rede — mesma exposição que já existe visualmente no modal.
let pairingModeActive = false
const clients = new Set<ConnectedClient>()

// ─── PIN Management ──────────────────────────────────────────────────────────

function generatePin(): string {
  const bytes = crypto.randomBytes(PIN_LENGTH)
  let pin = ''
  for (let i = 0; i < PIN_LENGTH; i++) {
    pin += (bytes[i] % 10).toString()
  }
  return pin
}

function regeneratePin(): string {
  currentPin = generatePin()
  pinCreatedAt = Date.now()
  return currentPin
}

function validatePin(pin: string, clientIp: string): boolean {
  // Rate limiting
  const now = Date.now()
  const attempts = pinAttempts.get(clientIp) ?? []
  const recentAttempts = attempts.filter(t => now - t < PIN_WINDOW_MS)
  if (recentAttempts.length >= MAX_PIN_ATTEMPTS) return false

  recentAttempts.push(now)
  pinAttempts.set(clientIp, recentAttempts)

  return pin === currentPin && (now - pinCreatedAt) < PIN_TTL_MS
}

/**
 * PIN atual — regenerado automaticamente ao expirar, para que a UI
 * (modal "Conectar App") nunca exiba um PIN que o validatePin rejeitaria.
 */
export function getCurrentPin(): string {
  if (!currentPin || Date.now() - pinCreatedAt >= PIN_TTL_MS) regeneratePin()
  return currentPin
}

/** Liga/desliga o modo de pareamento (ver comentário acima de `pairingModeActive`). */
export function setPairingMode(active: boolean): void {
  pairingModeActive = active
}

/** PIN atual, apenas se o modo de pareamento estiver ativo — usado no /api/ping. */
export function getPairingPin(): string | null {
  if (!pairingModeActive) return null
  return getCurrentPin()
}

// ─── Network Discovery ───────────────────────────────────────────────────────

// Nomes de adaptadores virtuais/túnel comuns (VPN, WSL, máquinas virtuais) que
// não são a rede local real — não adianta anunciar esse IP pro app achar,
// o celular não consegue alcançá-lo.
const VIRTUAL_IFACE_NAME = /virtualbox|vmware|hyper-v|vethernet|docker|wsl|tailscale|zerotier|utun|tun\d|tap\d/i

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function getLocalIp(): string {
  const interfaces = os.networkInterfaces()
  const candidates: { name: string; address: string }[] = []
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address })
      }
    }
  }

  // Preferência: interface com nome "normal" (Wi-Fi/Ethernet) e IP de rede
  // privada — é essa que o celular na mesma rede consegue alcançar.
  const real = candidates.find((c) => !VIRTUAL_IFACE_NAME.test(c.name) && isPrivateIPv4(c.address))
  if (real) return real.address

  // Sem essa combinação: qualquer IP de rede privada serve de fallback.
  const anyPrivate = candidates.find((c) => isPrivateIPv4(c.address))
  if (anyPrivate) return anyPrivate.address

  // Último recurso: comportamento antigo (primeira interface não-interna).
  return candidates[0]?.address ?? '127.0.0.1'
}

// ─── Message Helpers ─────────────────────────────────────────────────────────

function wrap(payload: CompanionEvent): string {
  return JSON.stringify({ id: crypto.randomUUID(), payload } satisfies WsMessage)
}

function send(ws: WebSocket, payload: CompanionEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(wrap(payload))
  }
}

function sendResponse(ws: WebSocket, requestId: string, ok: boolean, data?: unknown, error?: string) {
  send(ws, { type: 'api:response', requestId, ok, data, error } satisfies ApiResponse)
}

/** Notifica tanto os companions autenticados quanto as janelas do desktop
 *  (mesmo canal 'chat:event' que o renderer já escuta) — mantém os dois
 *  lados em sincronia quando uma sessão/pasta muda por qualquer um deles. */
function broadcastSessionEvent(event: ChatEvent) {
  forwardChatEvent(event)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('chat:event', event)
    }
  }
}

function forkId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 21)
}

// ─── Request Handlers ────────────────────────────────────────────────────────

async function handleRequest(client: ConnectedClient, requestId: string, req: CompanionRequest) {
  const { ws } = client

  // Heartbeat — responde pong para o client medir latência
  if ((req as { type: string }).type === 'ping') {
    send(ws, { type: 'pong' } as unknown as CompanionEvent)
    return
  }

  // Auth é o único request permitido sem autenticação
  if (req.type === 'auth') {
    // 1º: token persistente de um pareamento anterior
    if (req.token && (await validateDeviceToken(req.token))) {
      client.authenticated = true
      client.deviceName = req.deviceName ?? 'Companion'
      const resp: AuthOkResponse = {
        type: 'auth:ok',
        deviceName: client.deviceName,
        serverVersion: app.getVersion(),
        deviceToken: req.token,
      }
      send(ws, resp)
      console.log(`[Companion] Device reconnected via token: ${client.deviceName}`)
      return
    }

    // 2º: PIN (primeiro pareamento) — emite token persistente no sucesso
    if (req.pin && validatePin(req.pin, getIp(ws))) {
      client.authenticated = true
      client.deviceName = req.deviceName ?? 'Companion'
      const deviceToken = await registerDevice(client.deviceName)
      const resp: AuthOkResponse = {
        type: 'auth:ok',
        deviceName: client.deviceName,
        serverVersion: app.getVersion(),
        deviceToken,
      }
      send(ws, resp)
      console.log(`[Companion] Device paired: ${client.deviceName}`)
    } else {
      const resp: AuthErrorResponse = { type: 'auth:error', reason: 'invalid_pin' }
      send(ws, resp)
    }
    return
  }

  // Todos os outros requests exigem autenticação
  if (!client.authenticated) {
    sendResponse(ws, requestId, false, undefined, 'Não autenticado')
    return
  }

  try {
    switch (req.type) {
      case 'sessions:list': {
        const keys = await listKeys('session/')
        const sessions = (
          await Promise.all(keys.map(k => readJson<SessionInfo>(k)))
        ).filter((s): s is SessionInfo => s !== null)
        sessions.sort((a, b) => b.updatedAt - a.updatedAt)

        // Sanitizar: remover dados sensíveis
        const safe = sessions.map(s => ({
          id: s.id,
          title: s.title,
          mode: s.mode,
          pinned: s.pinned,
          archived: s.archived,
          folderId: s.folderId,
          parentId: s.parentId,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          orchestration: s.orchestration,
        }))
        sendResponse(ws, requestId, true, safe)
        break
      }

      case 'sessions:search': {
        const hits = await searchSessions(req.query ?? '')
        sendResponse(ws, requestId, true, hits)
        break
      }

      case 'messages:get': {
        const messages = await readJson<ChatMessage[]>(StorageKeys.messages(req.sessionId)) ?? []
        // Enviar apenas as últimas N mensagens para não sobrecarregar
        const limit = req.limit ?? 50
        const recent = messages.slice(-limit)
        sendResponse(ws, requestId, true, recent)
        break
      }

      case 'messages:send': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, 'Janela principal indisponível')
          return
        }

        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          return
        }

        // Pastas do modo código enviadas pelo app: persistem na sessão
        // (mesmo comportamento do desktop, onde o send grava directory).
        if (req.directory && (session.directory !== req.directory ||
            JSON.stringify(session.extraDirectories ?? []) !== JSON.stringify(req.extraDirectories ?? []))) {
          session.directory = req.directory
          session.extraDirectories = req.extraDirectories
          session.updatedAt = Date.now()
          await writeJson(StorageKeys.session(session.id), session)
          broadcastSessionEvent({ type: 'session', sessionId: session.id, session })
        }

        // Listar provedores conectados para resolver o modelo
        const connected = await listCredentialProviders()

        const input: SendMessageInput = {
          sessionId: req.sessionId,
          text: req.text,
          files: req.files,
          providerId: req.providerId ?? connected[0] ?? 'openai',
          modelId: req.modelId ?? 'gpt-4o',
          mode: session.mode,
          options: req.options ?? {},
          directory: req.directory ?? session.directory,
          extraDirectories: req.extraDirectories ?? session.extraDirectories,
          workerModel: req.workerModel,
        }

        void runChat(win, input)
        sendResponse(ws, requestId, true)
        break
      }

      case 'sessions:create': {
        const now = Date.now()
        const session: SessionInfo = {
          id: crypto.randomUUID().replace(/-/g, '').slice(0, 21),
          title: req.title ?? (req.mode === 'chat' ? 'Nova conversa' : 'Nova sessão de código'),
          mode: req.mode,
          pinned: false,
          archived: false,
          folderId: null,
          createdAt: now,
          updatedAt: now,
        }
        await writeJson(StorageKeys.session(session.id), session)
        // Notifica o renderer do desktop e demais companions
        forwardChatEvent({ type: 'session', sessionId: session.id, session })
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('chat:event', { type: 'session', sessionId: session.id, session })
          }
        }
        sendResponse(ws, requestId, true, session)
        break
      }

      case 'chat:abort': {
        abortChat(req.sessionId)
        abortOrchestration(req.sessionId)
        sendResponse(ws, requestId, true)
        break
      }

      case 'ask:reply': {
        const ok = askReply(req.requestId, req.value)
        sendResponse(ws, requestId, ok)
        break
      }

      case 'models:list': {
        const snapshot = await getModelsSnapshot()
        sendResponse(ws, requestId, true, snapshot)
        break
      }

      case 'models:select': {
        // A seleção de modelo é feita no renderer (localStorage) —
        // para o companion, broadcastamos um evento para o renderer atualizar
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:model-select', {
              providerId: req.providerId,
              modelId: req.modelId,
            })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'catalog:get': {
        const catalog = await getCatalog()
        sendResponse(ws, requestId, true, catalog)
        break
      }

      case 'analytics:summary': {
        const range = req.range ?? '7d'
        const analytics = await computeAnalytics(range)
        sendResponse(ws, requestId, true, analytics)
        break
      }

      case 'sessions:rename': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          break
        }
        const updated: SessionInfo = { ...session, title: req.title, updatedAt: Date.now() }
        await writeJson(StorageKeys.session(updated.id), updated)
        broadcastSessionEvent({ type: 'session', sessionId: updated.id, session: updated })
        sendResponse(ws, requestId, true, updated)
        break
      }

      case 'sessions:pin': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          break
        }
        const updated: SessionInfo = { ...session, pinned: req.pinned, updatedAt: Date.now() }
        await writeJson(StorageKeys.session(updated.id), updated)
        broadcastSessionEvent({ type: 'session', sessionId: updated.id, session: updated })
        sendResponse(ws, requestId, true, updated)
        break
      }

      case 'sessions:archive': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          break
        }
        const updated: SessionInfo = { ...session, archived: req.archived, updatedAt: Date.now() }
        await writeJson(StorageKeys.session(updated.id), updated)
        broadcastSessionEvent({ type: 'session', sessionId: updated.id, session: updated })
        sendResponse(ws, requestId, true, updated)
        break
      }

      case 'sessions:move-folder': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          break
        }
        const updated: SessionInfo = { ...session, folderId: req.folderId, updatedAt: Date.now() }
        await writeJson(StorageKeys.session(updated.id), updated)
        broadcastSessionEvent({ type: 'session', sessionId: updated.id, session: updated })
        sendResponse(ws, requestId, true, updated)
        break
      }

      case 'sessions:delete': {
        const keys = await listKeys('session/')
        const all = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
          (s): s is SessionInfo => s !== null,
        )
        // Cascata: deletar um orquestrador aborta e remove seus workers filhos.
        const ids = [req.sessionId, ...all.filter((s) => s.parentId === req.sessionId).map((s) => s.id)]
        for (const id of ids) {
          abortChat(id)
          abortOrchestration(id)
          await removeJson(StorageKeys.session(id))
          await removeJson(StorageKeys.messages(id))
          await removeJson(StorageKeys.planReview(id))
          broadcastSessionEvent({ type: 'session:deleted', sessionId: id })
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'sessions:fork': {
        const source = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!source) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          break
        }
        const allMsgs = (await readJson<ChatMessage[]>(StorageKeys.messages(req.sessionId))) ?? []
        let msgs = allMsgs
        if (req.messageId) {
          const idx = msgs.findIndex((m) => m.id === req.messageId)
          if (idx >= 0) msgs = msgs.slice(0, idx + 1)
        }

        // Título "Original (fork #n)": n = maior contador existente do mesmo original + 1
        const baseTitle = source.title.replace(/ \(fork #\d+\)$/, '')
        const escaped = baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const counterRe = new RegExp(`^${escaped} \\(fork #(\\d+)\\)$`)
        const keys = await listKeys('session/')
        const allSessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
          (s): s is SessionInfo => s !== null,
        )
        const maxFork = allSessions.reduce((max, s) => {
          const match = counterRe.exec(s.title)
          return match ? Math.max(max, Number(match[1])) : max
        }, 0)

        const now = Date.now()
        const fork: SessionInfo = {
          ...source,
          id: forkId(),
          title: `${baseTitle} (fork #${maxFork + 1})`,
          pinned: false,
          createdAt: now,
          updatedAt: now,
        }
        delete fork.parentId
        delete fork.orchestration
        delete fork.revert

        const cloned = msgs.map((m) => ({
          ...m,
          id: forkId(),
          parts: m.parts.map((p) => ({ ...p, id: forkId() })),
        }))

        await writeJson(StorageKeys.session(fork.id), fork)
        await writeJson(StorageKeys.messages(fork.id), cloned)
        broadcastSessionEvent({ type: 'session', sessionId: fork.id, session: fork })
        sendResponse(ws, requestId, true, fork)
        break
      }

      case 'sessions:revert': {
        const revertState = await revertSession(req.sessionId, req.messageId)
        if (revertState !== null) {
          const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(req.sessionId))) ?? []
          sendResponse(ws, requestId, true, { revert: revertState, messages })
        } else {
          sendResponse(ws, requestId, false, undefined, 'Não foi possível reverter')
        }
        break
      }

      case 'sessions:unrevert': {
        const done = await unrevertSession(req.sessionId)
        if (done) {
          const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(req.sessionId))) ?? []
          sendResponse(ws, requestId, true, { messages })
        } else {
          sendResponse(ws, requestId, false, undefined, 'Nada para desfazer')
        }
        break
      }

      case 'memory:list': {
        const memories = await listMemories()
        sendResponse(ws, requestId, true, memories)
        break
      }

      case 'memory:update': {
        const updated = await updateMemory(req.id, req.patch)
        if (updated) sendResponse(ws, requestId, true, updated)
        else sendResponse(ws, requestId, false, undefined, 'Memória não encontrada')
        break
      }

      case 'memory:delete': {
        await removeMemory(req.id)
        sendResponse(ws, requestId, true)
        break
      }

      case 'memory:promote': {
        const promoted = await promoteMemory(req.id)
        if (promoted) sendResponse(ws, requestId, true, promoted)
        else sendResponse(ws, requestId, false, undefined, 'Memória não pode ser promovida')
        break
      }

      case 'memory:doc': {
        const full = await getMemoryFull(req.id)
        if (full) sendResponse(ws, requestId, true, full.document)
        else sendResponse(ws, requestId, false, undefined, 'Memória não encontrada')
        break
      }

      case 'fs:list-dirs': {
        // Navegação de pastas do desktop para o seletor do app (modo código).
        // Só lista DIRETÓRIOS (nunca conteúdo de arquivos) e exige auth.
        const target = nodePath.resolve(req.path ?? os.homedir())
        try {
          const entries = await readdir(target, { withFileTypes: true })
          const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
            .map((e) => ({ name: e.name, path: nodePath.join(target, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name))
          const parent = nodePath.dirname(target)
          sendResponse(ws, requestId, true, {
            path: target,
            parent: parent !== target ? parent : null,
            dirs,
          })
        } catch (err) {
          sendResponse(ws, requestId, false, undefined, `Não foi possível listar: ${(err as Error).message}`)
        }
        break
      }

      case 'folders:list': {
        const folders = (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
        sendResponse(ws, requestId, true, folders)
        break
      }

      case 'folders:create': {
        const folders = (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
        const folder: FolderInfo = {
          id: forkId(),
          name: req.name,
          mode: req.mode,
          pinned: false,
          createdAt: Date.now(),
        }
        const next = [...folders, folder]
        await writeJson(StorageKeys.folders, next)
        broadcastSessionEvent({ type: 'folders', folders: next })
        sendResponse(ws, requestId, true, folder)
        break
      }

      case 'folders:rename': {
        const folders = (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
        const next = folders.map((f) => (f.id === req.folderId ? { ...f, name: req.name } : f))
        await writeJson(StorageKeys.folders, next)
        broadcastSessionEvent({ type: 'folders', folders: next })
        sendResponse(ws, requestId, true, next)
        break
      }

      case 'folders:pin': {
        const folders = (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
        const next = folders.map((f) => (f.id === req.folderId ? { ...f, pinned: req.pinned } : f))
        await writeJson(StorageKeys.folders, next)
        broadcastSessionEvent({ type: 'folders', folders: next })
        sendResponse(ws, requestId, true, next)
        break
      }

      case 'folders:delete': {
        const folders = (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
        const next = folders.filter((f) => f.id !== req.folderId)
        await writeJson(StorageKeys.folders, next)

        // Sessões da pasta removida voltam pra raiz
        const keys = await listKeys('session/')
        const sessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
          (s): s is SessionInfo => s !== null,
        )
        for (const s of sessions) {
          if (s.folderId === req.folderId) {
            const updated: SessionInfo = { ...s, folderId: null, updatedAt: Date.now() }
            await writeJson(StorageKeys.session(updated.id), updated)
            broadcastSessionEvent({ type: 'session', sessionId: updated.id, session: updated })
          }
        }

        broadcastSessionEvent({ type: 'folders', folders: next })
        sendResponse(ws, requestId, true, next)
        break
      }

      case 'plan:read-file': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session?.directory) {
          sendResponse(ws, requestId, false, undefined, 'Sessão sem diretório')
          break
        }
        const content = await readPlanFile(session.directory)
        sendResponse(ws, requestId, true, content)
        break
      }

      case 'plan:review-accept': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, 'Janela principal indisponível')
          break
        }
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          break
        }
        // Envia uma nova mensagem de implementação (mesma lógica do desktop)
        const canOrchestrate = req.orchestrate && session.mode === 'code'
        const input: SendMessageInput = {
          sessionId: req.sessionId,
          text: 'Implemente o plano acima.',
          providerId: req.providerId ?? 'openai',
          modelId: req.modelId ?? 'gpt-4o',
          mode: session.mode,
          options: {
            planReview: { status: 'implementing', messageId: req.messageId, permissionMode: req.permissionMode },
            permissionMode: req.permissionMode,
            ...(canOrchestrate ? { orchestrate: {}, loop: true, subagents: true, plan: undefined } : {}),
          },
          directory: session.directory,
          extraDirectories: session.extraDirectories,
        }
        if (canOrchestrate) {
          void runOrchestration(win, input)
        } else {
          void runChat(win, input)
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'plan:review-reject': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (session?.directory) {
          await deletePlanFile(session.directory)
        }
        await removeJson(StorageKeys.planReview(req.sessionId))
        // Notifica o renderer para atualizar o estado
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('chat:event', {
              type: 'plan:review',
              sessionId: req.sessionId,
              review: { status: 'rejected', messageId: '' },
            })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'plan:review-revise': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, 'Janela principal indisponível')
          break
        }
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, 'Sessão não encontrada')
          break
        }
        const input: SendMessageInput = {
          sessionId: req.sessionId,
          text: req.feedback,
          providerId: req.providerId ?? 'openai',
          modelId: req.modelId ?? 'gpt-4o',
          mode: session.mode,
          options: {
            planReview: { status: 'revising', messageId: req.messageId, permissionMode: req.permissionMode },
            permissionMode: req.permissionMode,
          },
          directory: session.directory,
          extraDirectories: session.extraDirectories,
        }
        void runChat(win, input)
        sendResponse(ws, requestId, true)
        break
      }

      case 'orchestration:approve': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, 'Janela principal indisponível')
          break
        }
        await approvePlan(win, req.sessionId, req.planId, req.taskIds)
        sendResponse(ws, requestId, true)
        break
      }

      case 'orchestration:reject': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, 'Janela principal indisponível')
          break
        }
        await rejectPlan(win, req.sessionId)
        sendResponse(ws, requestId, true)
        break
      }

      case 'status:get': {
        const keys = await listKeys('session/')
        const pendingAsksCount = countPendingAsks()
        const status: StatusUpdate = {
          type: 'status:update',
          online: true,
          activeSessions: keys.length,
          pendingAsks: pendingAsksCount,
          uptime: process.uptime(),
        }
        sendResponse(ws, requestId, true, status)
        break
      }

      default:
        sendResponse(ws, requestId, false, undefined, 'Tipo de request desconhecido')
    }
  } catch (err) {
    sendResponse(ws, requestId, false, undefined, (err as Error).message)
  }
}

function countPendingAsks(): number {
  // Conta roughly via BrowserWindow events
  return 0 // placeholder — o evento real vem do ask-broker
}

function getIp(ws: WebSocket): string {
  return (ws as any)._socket?.remoteAddress ?? 'unknown'
}

// ─── Event Forwarding (Desktop → Companion) ──────────────────────────────────

/**
 * Hook no broadcastChatEvent: retransmite todos os ChatEvent para
 * todos os companions autenticados.
 */
export function forwardChatEvent(event: ChatEvent): void {
  const payload = wrap({ type: 'chat:event', event } as CompanionEvent)
  for (const client of clients) {
    if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload)
    }
  }
}

/**
 * Notifica companion sobre permissão/question pendente.
 */
export function notifyCompanionAsk(
  sessionId: string,
  requestId: string,
  kind: 'permission' | 'question',
  title: string,
  questions?: unknown[],
): void {
  const notification: CompanionEvent = {
    type: 'notify:pending-ask',
    sessionId,
    requestId,
    kind,
    title,
    questions,
  }
  const payload = wrap(notification)
  for (const client of clients) {
    if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload)
    }
  }
}

/**
 * Notifica companion sobre nova mensagem do assistente.
 */
export function notifyCompanionMessage(
  sessionId: string,
  sessionTitle: string,
  messagePreview: string,
): void {
  const notification: CompanionEvent = {
    type: 'notify:new-message',
    sessionId,
    sessionTitle,
    messagePreview,
  }
  const payload = wrap(notification)
  for (const client of clients) {
    if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload)
    }
  }
}

// ─── Server Lifecycle ────────────────────────────────────────────────────────

export function startCompanionServer(): { port: number; ip: string; pin: string; httpPort: number } {
  if (wss) return { port: PORT, ip: getLocalIp(), pin: currentPin, httpPort: COMPANION_HTTP_PORT }

  server = createServer()
  wss = new WebSocketServer({ server })

  regeneratePin()

  // Iniciar servidor HTTP REST junto com o WS
  startCompanionHttpServer(validatePin, getPairingPin, validateDeviceToken)

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    const client: ConnectedClient = {
      ws,
      authenticated: false,
      deviceName: '',
      connectedAt: Date.now(),
    }
    clients.add(client)

    console.log(`[Companion] New connection from ${getIp(ws)}`)

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage
        if (msg.payload && typeof (msg.payload as any).type === 'string') {
          void handleRequest(client, msg.id, msg.payload as CompanionRequest)
        }
      } catch (err) {
        console.error('[Companion] Invalid message:', err)
      }
    })

    ws.on('close', () => {
      clients.delete(client)
      console.log(`[Companion] Client disconnected: ${client.deviceName}`)
    })

    ws.on('error', (err: Error) => {
      console.error('[Companion] WebSocket error:', err)
      clients.delete(client)
    })
  })

  server.listen(PORT, '0.0.0.0')

  console.log(`[Companion] Server started on ${getLocalIp()}:${PORT}`)
  console.log(`[Companion] HTTP API on ${getLocalIp()}:${COMPANION_HTTP_PORT}`)
  console.log(`[Companion] Pairing PIN: ${currentPin}`)

  return { port: PORT, ip: getLocalIp(), pin: currentPin, httpPort: COMPANION_HTTP_PORT }
}

export function stopCompanionServer(): void {
  // Parar servidor HTTP
  stopCompanionHttpServer()

  // Parar servidor WS
  for (const client of clients) {
    client.ws.close()
  }
  clients.clear()
  wss?.close()
  server?.close()
  wss = null
  server = null
}

export function getCompanionStatus() {
  return {
    running: wss !== null,
    port: PORT,
    httpPort: COMPANION_HTTP_PORT,
    httpRunning: isCompanionHttpRunning(),
    ip: getLocalIp(),
    pin: wss ? getCurrentPin() : currentPin,
    connectedClients: [...clients].filter(c => c.authenticated).map(c => ({
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
    })),
  }
}
