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
import type {
  CompanionRequest,
  CompanionEvent,
  WsMessage,
  AuthOkResponse,
  AuthErrorResponse,
  ApiResponse,
  StatusUpdate,
} from '@shared/companion'
import type { ChatEvent, SessionInfo, ChatMessage, SendMessageInput } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { readJson, listKeys } from './storage'
import { listCredentialProviders } from './auth'
import { reply as askReply } from './ask-broker'
import { abortChat, runChat } from './chat-engine'
import { abortOrchestration } from './orchestrator'
import { getCatalog } from './catalog'
import { getModelsSnapshot } from './models'
import { computeAnalytics } from './analytics'
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

// ─── Network Discovery ───────────────────────────────────────────────────────

export function getLocalIp(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
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
    if (validatePin(req.pin, getIp(ws))) {
      client.authenticated = true
      client.deviceName = req.deviceName ?? 'Companion'
      const resp: AuthOkResponse = {
        type: 'auth:ok',
        deviceName: client.deviceName,
        serverVersion: app.getVersion(),
      }
      send(ws, resp)
      console.log(`[Companion] Device connected: ${client.deviceName}`)
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
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          orchestration: s.orchestration,
        }))
        sendResponse(ws, requestId, true, safe)
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

        // Listar provedores conectados para resolver o modelo
        const connected = await listCredentialProviders()

        const input: SendMessageInput = {
          sessionId: req.sessionId,
          text: req.text,
          providerId: req.providerId ?? connected[0] ?? 'openai',
          modelId: req.modelId ?? 'gpt-4o',
          mode: session.mode,
          options: {},
          directory: session.directory,
        }

        void runChat(win, input)
        sendResponse(ws, requestId, true)
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
  startCompanionHttpServer(validatePin)

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
