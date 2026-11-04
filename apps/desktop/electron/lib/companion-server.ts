/**
 * WebSocket server for Orbit Companion.
 *
 * It runs inside the Electron main process, exposing a secure API
 * over WebSocket so the mobile app can control the desktop over the local network.
 *
 * Security:
 * - Pairing PIN (6 digits) generated randomly at startup
 * - Authentication required before any operation
 * - Rate limiting on the PIN (5 attempts per minute)
 * - The API credentials (auth.json) are NEVER transmitted to the companion
 */

import { WebSocketServer, WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
  SessionStateResponse,
  PendingAskState,
  BranchesResponse,
  SessionModeOverrides,
  SessionModeChangeEvent,
  SessionPrefsSnapshot,
  SessionPrefsChangeEvent,
  ReasoningPrefsMap,
  ReasoningPrefsChangeEvent,
  RotationChangeEvent,
  WorkerConfigSnapshot,
  WorkerConfigChangeEvent,
  AppPreferences,
  AppPreferencesChangeEvent,
  MessageQueueSnapshot,
  MessageQueueChangeEvent,
} from '@shared/companion'
import { SESSION_BUSY_ERROR } from '@shared/companion'
import type { ChatEvent, SessionInfo, FolderInfo, ChatMessage, MessagePart, SendMessageInput, PlanReview, RotationConfig } from '@shared/chat'
import type { RoutineEvent } from '@shared/routines'
import { setArchivedState } from '@shared/archive'
import type { PipelineEvent } from '@shared/pipeline'
import { StorageKeys, normalizeOrchestrationPlan } from '@shared/chat'
import { readJson, writeJson, removeJson, listKeys } from './storage'
import { searchSessions } from './search-sessions'
import { listCredentialProviders } from './auth'
import { replyOrResume } from './ask-resume'
import {
  revert as revertSession,
  revertUncertain as revertUncertainSession,
  unrevert as unrevertSession,
} from './session/revert'
import { getRunningSessionIds } from './chat-engine'
import { abortSession, dispatchSend } from './send-dispatch'
import { readAppLanguage } from './app-language'
import { getLoopRunningSessionIds } from './loop-engine'
import { approvePlan, getOrchestrationRunningSessionIds, rejectPlan, resumePlan } from './orchestrator'
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
import * as routines from './routines'
import * as pipelineApi from './pipeline'
import { setGlobalMode } from './permission/global-mode'
import { deleteMediaJournals } from './session/media-journal'
import {
  rewriteMediaPart as rewriteMediaPartOne,
  rewriteMessage as rewriteMessageMedia,
  rewriteMessages as rewriteMessagesMedia,
} from './companion-media'
import {
  startCompanionHttpServer,
  stopCompanionHttpServer,
  isCompanionHttpRunning,
  HTTP_PORT as COMPANION_HTTP_PORT,
  getWorkerConfigCache,
} from './companion-http'
import { createAssetToken } from './companion-token'
import { tNow } from './i18n'

const execFileAsync = promisify(execFile)

const PORT = 3847
const PIN_LENGTH = 6
const MAX_PIN_ATTEMPTS = 5
const PIN_WINDOW_MS = 60_000 // 1 minute
const PIN_TTL_MS = 300_000 // PIN valid for 5 minutes

interface ConnectedClient {
  ws: WebSocket
  authenticated: boolean
  deviceName: string
  connectedAt: number
  /** Hostname/IP the client used to connect — base of the rewritten media
   *  URLs (the phone only reaches the desktop through the IP it used itself). */
  mediaHost: string
}

let server: Server | null = null
let wss: WebSocketServer | null = null
let wsBindError: string | null = null // bind error (e.g. port taken by another Orbit instance)
let currentPin: string = ''
let pinCreatedAt: number = 0
const pinAttempts = new Map<string, number[]>() // ip → timestamps

// ─── Paired devices (persistent tokens) ─────────────────────────────
// The PIN expires in 5 min, so it only serves the FIRST pairing.
// On authenticating with the PIN, the desktop issues a persistent token that the app
// stores and uses on the next connections — that is what makes the connection survive
// app restarts without asking for the PIN again.

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

/** Orchestra conductor configured on the desktop, in the SendMessageInput shape. */
function conductorFromConfig(): SendMessageInput['orchestratorModel'] {
  const { orchestratorModel, orchestratorReasoning } = getWorkerConfigCache()
  return orchestratorModel ? { ...orchestratorModel, reasoning: orchestratorReasoning ?? undefined } : undefined
}

export async function validateDeviceToken(token: string): Promise<boolean> {
  if (!token) return false
  const devices = await loadDevices()
  const device = devices.find((d) => {
    // Constant-time comparison (tokens have a fixed size of 64 hex chars)
    if (d.token.length !== token.length) return false
    return crypto.timingSafeEqual(Buffer.from(d.token), Buffer.from(token))
  })
  if (!device) return false
  device.lastSeenAt = Date.now()
  void writeJson(DEVICES_KEY, devices)
  return true
}
// Pairing mode: active while the "Connect App" modal is open on the
// desktop. While active, the current PIN is exposed by the public discovery
// endpoint (/api/ping), letting the app connect with a tap when it finds
// the desktop on the network — the same exposure that already exists visually in the modal.
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
 * Current PIN — regenerated automatically on expiry, so the UI
 * ("Connect App" modal) never shows a PIN that validatePin would reject.
 */
export function getCurrentPin(): string {
  if (!currentPin || Date.now() - pinCreatedAt >= PIN_TTL_MS) regeneratePin()
  return currentPin
}

/** Turns pairing mode on/off (see the comment above `pairingModeActive`). */
export function setPairingMode(active: boolean): void {
  pairingModeActive = active
}

/** Current PIN, only if pairing mode is active — used in /api/ping. */
export function getPairingPin(): string | null {
  if (!pairingModeActive) return null
  return getCurrentPin()
}

// ─── Network Discovery ───────────────────────────────────────────────────────

// Names of common virtual/tunnel adapters (VPN, WSL, virtual machines) that
// are not the real local network — advertising that IP does not help the app find
// the desktop, the phone cannot reach it.
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

  // Preference: an interface with a "normal" name (Wi-Fi/Ethernet) and a private
  // network IP — that is the one the phone on the same network can reach.
  const real = candidates.find((c) => !VIRTUAL_IFACE_NAME.test(c.name) && isPrivateIPv4(c.address))
  if (real) return real.address

  // Without that combination: any private network IP serves as a fallback.
  const anyPrivate = candidates.find((c) => isPrivateIPv4(c.address))
  if (anyPrivate) return anyPrivate.address

  // Last resort: the old behavior (first non-internal interface).
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

/** Notifies both the authenticated companions and the desktop windows
 *  (the same 'chat:event' channel the renderer already listens to) — it keeps both
 *  sides in sync when a session/folder changes by either of them. */
/**
 * Propagates a session/folder change to every window and to the companions.
 * Exported because the maintenance tools (tools/sessions.ts) mutate
 * sessions through the main and need the renderer to follow.
 */
export function broadcastSessionEvent(event: ChatEvent) {
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

// ─── Media URL Rewriting ─────────────────────────────────────────────────────
// The mobile app has no access to the orbit-media:// protocol (registered only in the
// Electron main process), so the image URLs are rewritten to
// http://<client-host>:3848/api/media/<id>?t=<signed token> on delivery —
// both in the history (messages:get) and in the streaming (chat:event). The URL is
// built with the host the client itself used to connect, which is the only
// address the phone can reach.

function mediaBaseUrl(client: ConnectedClient): string {
  return `http://${client.mediaHost}:${COMPANION_HTTP_PORT}`
}

/** The rewriting lives in companion-media.ts (pure and tested); here only the
 *  token factory enters, which depends on the persisted secret. */
const rewriteMessage = (msg: ChatMessage, base: string) =>
  rewriteMessageMedia(msg, base, createAssetToken)
const rewriteMessages = (msgs: ChatMessage[], base: string) =>
  rewriteMessagesMedia(msgs, base, createAssetToken)
const rewriteMediaPart = (part: MessagePart, base: string) =>
  rewriteMediaPartOne(part, base, createAssetToken)

/** Sessions with something running in the main process: chat, loop (between
 *  iterations too) and orchestra. */
function runningSessionIds(): Set<string> {
  return new Set([
    ...getRunningSessionIds(),
    ...getLoopRunningSessionIds(),
    ...getOrchestrationRunningSessionIds(),
  ])
}

// ─── Request Handlers ────────────────────────────────────────────────────────

async function handleRequest(client: ConnectedClient, requestId: string, req: CompanionRequest) {
  const { ws } = client

  // Heartbeat — answers pong so the client can measure latency
  if ((req as { type: string }).type === 'ping') {
    send(ws, { type: 'pong' } as unknown as CompanionEvent)
    return
  }

  // Auth is the only request allowed without authentication
  if (req.type === 'auth') {
    // 1st: persistent token from a previous pairing
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

    // 2nd: PIN (first pairing) — issues a persistent token on success
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

  // Every other request requires authentication
  if (!client.authenticated) {
    sendResponse(ws, requestId, false, undefined, tNow('companion.server.notAuthenticated'))
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

        // Sanitize: what stays out is only the heavy fields (revert carries
        // a diff and discarded messages). The code-mode folders go in: without
        // them the mobile opens every existing chat as if it had no folder
        // associated — and the branch selector, which depends on the directory, disappears.
        const safe = sessions.map(s => ({
          id: s.id,
          title: s.title,
          mode: s.mode,
          pinned: s.pinned,
          archived: s.archived,
          folderId: s.folderId,
          directory: s.directory,
          extraDirectories: s.extraDirectories,
          parentId: s.parentId,
          routineId: s.routineId,
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

      case 'git:branches': {
        // Same commands as the desktop's ipcMain 'git:branches'.
        try {
          const [list, current] = await Promise.all([
            execFileAsync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: req.directory }),
            execFileAsync('git', ['branch', '--show-current'], { cwd: req.directory }),
          ])
          sendResponse(ws, requestId, true, {
            branches: list.stdout.trim().split('\n').filter(Boolean),
            current: current.stdout.trim(),
          } satisfies BranchesResponse)
        } catch (err) {
          sendResponse(ws, requestId, false, undefined, (err as Error).message)
        }
        break
      }

      case 'git:checkout': {
        try {
          await execFileAsync('git', ['checkout', req.branch], { cwd: req.directory })
          sendResponse(ws, requestId, true)
        } catch (err) {
          // Dirty tree: git refuses and its message is what the app shows,
          // the same as on the desktop — we do not force a checkout over the changes.
          sendResponse(ws, requestId, false, undefined, (err as Error).message)
        }
        break
      }

      case 'session:state': {
        // Plans, reviews and pending requests live outside the messages; without this
        // the mobile only knew them from the live events and lost the cards when
        // reopening the chat — or never saw them, when the request was issued before
        // the phone paired. And it is the same read the desktop does in
        // ensureMessages, so both apps show exactly the same cards.
        const [planReview, plan, pendingAsks] = await Promise.all([
          readJson<PlanReview>(StorageKeys.planReview(req.sessionId)),
          // Legacy plans (Portuguese keys/phase values) are translated at the read edge.
          readJson<unknown>(StorageKeys.orchestration(req.sessionId)).then(normalizeOrchestrationPlan),
          readJson<PendingAskState[]>(StorageKeys.pendingAsks(req.sessionId)),
        ])
        sendResponse(ws, requestId, true, {
          planReview: planReview ?? undefined,
          // A plan dismissed in the chat does not come back as a card — the read is the same as on
          // the desktop, so the mark counts for both apps.
          plan: plan?.dismissed ? undefined : plan ?? undefined,
          pendingAsks: pendingAsks ?? [],
        } satisfies SessionStateResponse)
        break
      }

      case 'sessions:running': {
        // same source as the renderer's IPC 'chat:running': the engine lives in the main,
        // so only it knows what is still running. Without this the phone that
        // connects in the middle of the execution shows the conversation stalled.
        sendResponse(ws, requestId, true, [...runningSessionIds()])
        break
      }

      case 'messages:get': {
        const messages = await readJson<ChatMessage[]>(StorageKeys.messages(req.sessionId)) ?? []
        // Send only the last N messages so as not to overload
        const limit = Math.min(req.limit ?? 50, 100)
        const offset = Math.max(req.offset ?? 0, 0)
        const end = Math.max(messages.length - offset, 0)
        const start = Math.max(end - limit, 0)
        const page = messages.slice(start, end)
        // The mobile does not know orbit-media:// (an Electron scheme — only the
        // streaming and sessions:unrevert rewrote it). Without this, the whole
        // history reaches the app raw and the images never load.
        const rewritten = rewriteMessages(page, mediaBaseUrl(client)) ?? page
        sendResponse(ws, requestId, true, rewritten)
        break
      }

      case 'messages:send': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noMainWindow'))
          return
        }

        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
          return
        }

        // Session still running (including between loop iterations and during
        // the orchestra): sending now would abort the turn halfway. Deciding
        // whether the session is free is the main process' job — the status the
        // phone saw may be stale (reconnect, idle between loop iterations).
        if (runningSessionIds().has(req.sessionId)) {
          sendResponse(ws, requestId, false, undefined, SESSION_BUSY_ERROR)
          return
        }

        // Code-mode folders sent by the app: they persist in the session
        // (same behavior as the desktop, where the send writes the directory).
        if (req.directory && (session.directory !== req.directory ||
            JSON.stringify(session.extraDirectories ?? []) !== JSON.stringify(req.extraDirectories ?? []))) {
          session.directory = req.directory
          session.extraDirectories = req.extraDirectories
          session.updatedAt = Date.now()
          await writeJson(StorageKeys.session(session.id), session)
          broadcastSessionEvent({ type: 'session', sessionId: session.id, session })
        }

        // List connected providers to resolve the model
        const [connected, language] = await Promise.all([
          listCredentialProviders(),
          readAppLanguage(),
        ])

        const input: SendMessageInput = {
          sessionId: req.sessionId,
          text: req.text,
          files: req.files,
          providerId: req.providerId ?? connected[0] ?? 'openai',
          modelId: req.modelId ?? 'gpt-4o',
          mode: session.mode,
          // The phone sends the mode of the global selector (synchronized with the
          // desktop): the turn follows a switch made mid-answer.
          options: req.options?.permissionMode ? { ...req.options, followGlobalPermission: true } : (req.options ?? {}),
          directory: req.directory ?? session.directory,
          extraDirectories: req.extraDirectories ?? session.extraDirectories,
          workerModel: req.workerModel,
          visionModel: req.visionModel,
          // The orchestra conductor is desktop config (Preferences / "+"):
          // the phone does not send it, so it comes from the copy the renderer pushes.
          ...(req.options?.orchestrate ? { orchestratorModel: conductorFromConfig() } : {}),
          loopConfig: req.loopConfig,
          // App language (published by the renderer). Without it the agent falls back to
          // the PROMPT's language — the desktop sends it on every send, and the
          // companion path did not.
          ...(language ? { language } : {}),
        }

        // Same routing as the desktop's chat:send: orchestra, loop or chat, with
        // the mode guards. It used to always leave here as a runChat, so from the
        // phone the orchestra became a plain chat and the loop ran a single turn.
        await dispatchSend(win, input)
        sendResponse(ws, requestId, true)
        break
      }

      case 'sessions:create': {
        const now = Date.now()
        const session: SessionInfo = {
          id: crypto.randomUUID().replace(/-/g, '').slice(0, 21),
          title:
            req.title ??
            tNow(req.mode === 'chat' ? 'chat.defaultTitle.chat' : 'chat.defaultTitle.code'),
          mode: req.mode,
          pinned: false,
          archived: false,
          folderId: null,
          createdAt: now,
          updatedAt: now,
        }
        await writeJson(StorageKeys.session(session.id), session)
        // Notifies the desktop renderer and the other companions
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
        // Same shutdown as the desktop: engines + pending requests + session
        // trust. Stopping halfway left the loop spinning.
        abortSession(req.sessionId)
        sendResponse(ws, requestId, true)
        break
      }

      case 'ask:reply': {
        // Same path as the desktop: a live request resolves right away, a card from an
        // execution already finished goes back to the conversation as a message.
        const ok = await replyOrResume(BrowserWindow.getAllWindows()[0] ?? null, req.requestId, req.value)
        sendResponse(ws, requestId, ok)
        break
      }

      case 'models:list': {
        const snapshot = await getModelsSnapshot()
        sendResponse(ws, requestId, true, snapshot)
        break
      }

      case 'models:select': {
        // The model selection is made in the renderer (localStorage) — for the
        // companion, we broadcast an event so the renderer updates. The
        // sessionId makes the choice count per chat (session override); without
        // it, it counts for the draft/new chat + the global default.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:model-select', {
              providerId: req.providerId,
              modelId: req.modelId,
              sessionId: req.sessionId ?? null,
            })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'rotation:select': {
        // Mirror of models:select: the rotations live in the renderer
        // (localStorage), so the choice made on the phone is applied there — and
        // from there it goes back to every companion through the broadcast.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:rotation-select', {
              rotationId: req.rotationId ?? null,
              sessionId: req.sessionId ?? null,
            })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'rotation:set': {
        // Rotation CRUD done on the phone: it sends the whole list for the
        // renderer to persist (source of truth), like prefs:set.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:rotation-set', { rotations: req.rotations ?? [] })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'queue:get': {
        sendResponse(ws, requestId, true, messageQueueCache)
        break
      }

      case 'queue:op': {
        // The queue lives in the renderer (it is the one that sends the next item): the
        // operation goes there, and the resulting queue comes back to everyone through
        // 'queue:change'.
        const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
        if (wins.length === 0) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noMainWindow'))
          return
        }
        for (const win of wins) win.webContents.send('companion:queue-op', req.op)
        sendResponse(ws, requestId, true)
        break
      }

      case 'modes:select': {
        // Mirror of models:select: the per-chat modes live in the renderer
        // (localStorage), so the choice made on the phone is applied there — and
        // from there it goes back to every companion through the broadcast.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:mode-select', {
              mode: req.mode,
              value: req.value,
              sessionId: req.sessionId ?? null,
            })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'reasoning:select': {
        // Same route as models:select: the thinking per model lives in the renderer
        // (localStorage), so the toggle made on the phone is applied there — and from
        // there it goes back to every companion through the 'reasoning:change' broadcast.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:reasoning-select', {
              providerId: req.providerId,
              modelId: req.modelId,
              pref: req.pref,
            })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'session:prefs-select': {
        // Thinking/autonomy of ONE chat chosen on the phone: the renderer is the
        // source of truth, so the choice is applied there — and from there it goes back to
        // every companion through 'session:prefs-change'.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:session-prefs-select', {
              sessionId: req.sessionId ?? null,
              reasoning: req.reasoning,
              permission: req.permission,
            })
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'prefs:get': {
        // Mirror of worker-config: the preferences live in the renderer, which
        // pushes the snapshot here on every change.
        sendResponse(ws, requestId, true, getAppPreferences())
        break
      }

      case 'prefs:set': {
        // Change made on the phone: it applies in the renderer (source of truth) and from
        // there the snapshot comes back to every companion.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:preferences-set', req.prefs)
          }
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'worker-config:set': {
        // Same route as modes:select: the config lives in the renderer, so the
        // choice made on the phone is applied there and comes back through the broadcast.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('companion:worker-config-set', req.config)
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
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
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
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
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
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
          break
        }
        const updated: SessionInfo = { ...setArchivedState(session, req.archived), updatedAt: Date.now() }
        await writeJson(StorageKeys.session(updated.id), updated)
        broadcastSessionEvent({ type: 'session', sessionId: updated.id, session: updated })
        sendResponse(ws, requestId, true, updated)
        break
      }

      case 'sessions:move-folder': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
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
        // Cascade: deleting an orchestrator aborts and removes its child workers.
        const ids = [req.sessionId, ...all.filter((s) => s.parentId === req.sessionId).map((s) => s.id)]
        for (const id of ids) {
          abortSession(id)
          await removeJson(StorageKeys.session(id))
          await removeJson(StorageKeys.messages(id))
          await removeJson(StorageKeys.planReview(id))
          await deleteMediaJournals(id).catch(() => {})
          broadcastSessionEvent({ type: 'session:deleted', sessionId: id })
        }
        sendResponse(ws, requestId, true)
        break
      }

      case 'sessions:fork': {
        const source = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!source) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
          break
        }
        const allMsgs = (await readJson<ChatMessage[]>(StorageKeys.messages(req.sessionId))) ?? []
        let msgs = allMsgs
        if (req.messageId) {
          const idx = msgs.findIndex((m) => m.id === req.messageId)
          if (idx >= 0) msgs = msgs.slice(0, idx + 1)
        }

        // Title "Original (fork #n)": n = highest existing counter of the same original + 1
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
          // Same rewriting as sessions:unrevert: the reverted message cannot
          // come back with a raw orbit-media:// to the app.
          sendResponse(ws, requestId, true, {
            revert: revertState,
            messages: rewriteMessages(messages, mediaBaseUrl(client)) ?? messages,
          })
        } else {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.revertFailed'))
        }
        break
      }

      case 'sessions:revertUncertain': {
        // The updated session (revert without the uncertain ones) also arrives through the
        // 'session' event; the response carries the state for the app to apply right away.
        const revertState = await revertUncertainSession(req.sessionId)
        if (revertState) sendResponse(ws, requestId, true, { revert: revertState })
        else sendResponse(ws, requestId, false, undefined, tNow('companion.server.nothingToRevert'))
        break
      }

      case 'sessions:unrevert': {
        const result = await unrevertSession(req.sessionId)
        if (result.done) {
          const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(req.sessionId))) ?? []
          // `result` describes what came back and what stayed intact due to a conflict —
          // the mobile shows the warning when there is a conflict.
          sendResponse(ws, requestId, true, {
            messages: rewriteMessages(messages, mediaBaseUrl(client)) ?? messages,
            result,
          })
        } else {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.nothingToUndo'))
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
        else sendResponse(ws, requestId, false, undefined, tNow('companion.server.memoryNotFound'))
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
        else sendResponse(ws, requestId, false, undefined, tNow('companion.server.memoryCannotPromote'))
        break
      }

      case 'memory:doc': {
        const full = await getMemoryFull(req.id)
        if (full) sendResponse(ws, requestId, true, full.document)
        else sendResponse(ws, requestId, false, undefined, tNow('companion.server.memoryNotFound'))
        break
      }

      case 'fs:list-dirs': {
        // Desktop folder navigation for the app's selector (code mode).
        // It only lists DIRECTORIES (never file contents) and requires auth.
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
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.listFailed', { error: (err as Error).message }))
        }
        break
      }

      case 'routines:list': {
        const data = await routines.loadAll()
        sendResponse(ws, requestId, true, data)
        break
      }

      case 'routines:create': {
        const routine = await routines.createRoutine(req.input)
        sendResponse(ws, requestId, true, routine)
        break
      }

      case 'routines:update': {
        const routine = await routines.updateRoutineFields(req.id, req.patch)
        if (routine) sendResponse(ws, requestId, true, routine)
        else sendResponse(ws, requestId, false, undefined, 'Routine not found')
        break
      }

      case 'routines:delete': {
        await routines.removeRoutineCompletely(req.id)
        sendResponse(ws, requestId, true)
        break
      }

      case 'routines:run': {
        const sessionId = await routines.runNow(req.id)
        sendResponse(ws, requestId, true, sessionId)
        break
      }

      case 'routines:prune-runs': {
        await routines.pruneOrphanRuns(req.sessionIds)
        sendResponse(ws, requestId, true)
        break
      }

      case 'routines:generate': {
        const result = await routines.generateRoutine(
          req.description,
          req.model,
          req.folders,
          req.language,
          req.mode,
          req.visionAvailable,
        )
        sendResponse(ws, requestId, true, result)
        break
      }

      case 'pipeline:list': {
        const [data, templates] = await Promise.all([pipelineApi.loadAll(), pipelineApi.listTemplates()])
        sendResponse(ws, requestId, true, { ...data, templates })
        break
      }

      case 'pipeline:create': {
        const created = await pipelineApi.createPipeline(req.input)
        sendResponse(ws, requestId, true, created)
        break
      }

      case 'pipeline:update': {
        const updated = await pipelineApi.updatePipeline(req.id, req.patch)
        if (updated) sendResponse(ws, requestId, true, updated)
        else sendResponse(ws, requestId, false, undefined, tNow('companion.server.pipelineNotFound'))
        break
      }

      case 'pipeline:delete': {
        await pipelineApi.removePipeline(req.id)
        sendResponse(ws, requestId, true)
        break
      }

      case 'pipeline:create-project': {
        const project = await pipelineApi.createProject(req.name, req.folders)
        sendResponse(ws, requestId, true, project)
        break
      }

      case 'pipeline:update-project': {
        const project = await pipelineApi.updateProject(req.id, req.patch)
        if (project) sendResponse(ws, requestId, true, project)
        else sendResponse(ws, requestId, false, undefined, tNow('companion.server.projectNotFound'))
        break
      }

      case 'pipeline:create-task': {
        const task = await pipelineApi.createTask(req.input)
        sendResponse(ws, requestId, true, task)
        break
      }

      case 'pipeline:update-task': {
        // A dependency cycle is rejected in the main process — the message goes back to the app.
        try {
          const task = await pipelineApi.updateTaskFields(req.pipelineId, req.taskId, req.patch)
          if (task) sendResponse(ws, requestId, true, task)
          else sendResponse(ws, requestId, false, undefined, tNow('companion.server.taskNotFound'))
        } catch (err) {
          sendResponse(ws, requestId, false, undefined, (err as Error).message)
        }
        break
      }

      case 'pipeline:delete-task': {
        await pipelineApi.removeTask(req.pipelineId, req.taskId)
        sendResponse(ws, requestId, true)
        break
      }

      case 'pipeline:start-task': {
        await pipelineApi.startTask(req.pipelineId, req.taskId, req.phase ?? 0)
        sendResponse(ws, requestId, true)
        break
      }

      case 'pipeline:pause-task': {
        await pipelineApi.pauseTask(req.pipelineId, req.taskId)
        sendResponse(ws, requestId, true)
        break
      }

      case 'pipeline:resume-task': {
        await pipelineApi.resumeTask(req.pipelineId, req.taskId)
        sendResponse(ws, requestId, true)
        break
      }

      case 'pipeline:toggle-queue': {
        if (req.enabled) pipelineApi.enableQueue(req.pipelineId)
        else pipelineApi.disableQueue(req.pipelineId)
        sendResponse(ws, requestId, true, req.enabled)
        break
      }

      case 'pipeline:save-template': {
        const templates = await pipelineApi.saveTemplate(req.template)
        sendResponse(ws, requestId, true, templates)
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
          archived: false,
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

      case 'folders:archive': {
        const folders = (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
        const next = folders.map((f) => (f.id === req.folderId ? { ...f, archived: req.archived } : f))
        await writeJson(StorageKeys.folders, next)

        // The chats of the folder follow its state — the same cascade as the
        // desktop's toggleFolderArchive: whoever is already in the target state is not
        // touched (nor re-emitted), and updatedAt is not changed so the chat does not
        // jump around in the ordering by activity.
        const keys = await listKeys('session/')
        const sessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
          (s): s is SessionInfo => s !== null,
        )
        for (const s of sessions) {
          if (s.folderId !== req.folderId || s.archived === req.archived) continue
          const updated = setArchivedState(s, req.archived)
          await writeJson(StorageKeys.session(updated.id), updated)
          broadcastSessionEvent({ type: 'session', sessionId: updated.id, session: updated })
        }

        broadcastSessionEvent({ type: 'folders', folders: next })
        sendResponse(ws, requestId, true, next)
        break
      }

      case 'folders:delete': {
        const folders = (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
        const next = folders.filter((f) => f.id !== req.folderId)
        await writeJson(StorageKeys.folders, next)

        // Sessions of the removed folder go back to the root
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

      case 'sidebar:organize': {
        // Reorganizing touches the map of automatic folders, which lives in the
        // renderer's localStorage — so the renderer is what runs it, through the same
        // path as 'models:select'. That way desktop and mobile run
        // literally the same function.
        const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
        if (windows.length === 0) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noDesktopWindow'))
          break
        }
        for (const win of windows) win.webContents.send('companion:organize-sidebar')
        sendResponse(ws, requestId, true)
        break
      }

      case 'plan:read-file': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session?.directory) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionWithoutFolder'))
          break
        }
        const content = await readPlanFile(session.directory)
        sendResponse(ws, requestId, true, content)
        break
      }

      case 'plan:review-accept': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noMainWindow'))
          break
        }
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
          break
        }
        // The review lives on disk, outside the messages: without writing the
        // "implementing" here, reopening the conversation (in any app) resurrected
        // the acceptance card with the plan already running. It is the same as
        // the renderer's acceptPlanReview does when the acceptance comes from the desktop.
        const aceito: PlanReview = {
          status: 'implementing',
          messageId: req.messageId,
          permissionMode: req.permissionMode,
        }
        await writeJson(StorageKeys.planReview(req.sessionId), aceito)
        broadcastSessionEvent({ type: 'plan:review', sessionId: req.sessionId, review: aceito })

        // Sends a new implementation message (same logic as the desktop)
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
        // Through the router: on the desktop the acceptance goes through sendMessage → chat:send,
        // so the same guards (and loop mode) have to count here.
        await dispatchSend(win, input)
        sendResponse(ws, requestId, true)
        break
      }

      case 'plan:review-reject': {
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (session?.directory) {
          await deletePlanFile(session.directory)
        }
        await removeJson(StorageKeys.planReview(req.sessionId))
        // Notifies the renderer AND the other companions — refusing on one phone
        // has to take the card off the desktop and off any other paired device.
        broadcastSessionEvent({
          type: 'plan:review',
          sessionId: req.sessionId,
          review: { status: 'rejected', messageId: '' },
        })
        sendResponse(ws, requestId, true)
        break
      }

      case 'plan:review-revise': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noMainWindow'))
          break
        }
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
          break
        }
        const review: PlanReview = {
          status: 'revising',
          messageId: req.messageId,
          permissionMode: req.permissionMode,
        }
        await writeJson(StorageKeys.planReview(req.sessionId), review)
        broadcastSessionEvent({ type: 'plan:review', sessionId: req.sessionId, review: review })
        const input: SendMessageInput = {
          sessionId: req.sessionId,
          text: req.feedback,
          providerId: req.providerId ?? 'openai',
          modelId: req.modelId ?? 'gpt-4o',
          mode: session.mode,
          options: {
            planReview: review,
            permissionMode: req.permissionMode,
          },
          directory: session.directory,
          extraDirectories: session.extraDirectories,
        }
        await dispatchSend(win, input)
        sendResponse(ws, requestId, true)
        break
      }

      case 'orchestration:approve': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noMainWindow'))
          break
        }
        await approvePlan(win, req.sessionId, req.planId, req.taskIds)
        sendResponse(ws, requestId, true)
        break
      }

      case 'orchestration:reject': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noMainWindow'))
          break
        }
        await rejectPlan(win, req.sessionId)
        sendResponse(ws, requestId, true)
        break
      }

      case 'orchestration:resume': {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.noMainWindow'))
          break
        }
        const session = await readJson<SessionInfo>(StorageKeys.session(req.sessionId))
        if (!session?.directory) {
          sendResponse(ws, requestId, false, undefined, tNow('companion.server.sessionNotFound'))
          break
        }
        // Same door as the desktop card: the models and settings the plan runs with come
        // from the worker config the desktop already holds (resumePlan keeps the plan's own).
        const cfg = getWorkerConfigCache()
        await resumePlan(win, {
          sessionId: req.sessionId,
          text: '',
          providerId: req.providerId ?? 'openai',
          modelId: req.modelId ?? 'gpt-4o',
          mode: 'code',
          options: { followGlobalPermission: true },
          directory: session.directory,
          extraDirectories: session.extraDirectories,
          workerModel: cfg.workerModel
            ? { ...cfg.workerModel, reasoning: cfg.workerReasoning ?? undefined }
            : undefined,
          orchestratorModel: cfg.orchestratorModel
            ? { ...cfg.orchestratorModel, reasoning: cfg.orchestratorReasoning ?? undefined }
            : undefined,
        })
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
  // Rough count via BrowserWindow events
  return 0 // placeholder — the real event comes from the ask-broker
}

function getIp(ws: WebSocket): string {
  return (ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? 'unknown'
}

/** Hostname/IP the client used to connect (Host header of the WS handshake).
 *  Fallback: local IP — covers clients that omit the header. */
function clientHostFromReq(req: IncomingMessage): string {
  const host = req.headers.host
  if (host) {
    try {
      const hostname = new URL(`http://${host}`).hostname
      if (hostname) return hostname
    } catch {
      /* malformed host — uses the fallback */
    }
  }
  return getLocalIp()
}

// ─── Event Forwarding (Desktop → Companion) ──────────────────────────────────

/**
 * Hook on broadcastChatEvent: it relays every ChatEvent to
 * every authenticated companion.
 */
export function forwardChatEvent(event: ChatEvent): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    const base = mediaBaseUrl(client)
    let out: ChatEvent = event
    if (event.type === 'message') {
      const rewritten = rewriteMessage(event.message, base)
      if (rewritten) out = { ...event, message: rewritten }
    } else if (event.type === 'messages') {
      const rewritten = rewriteMessages(event.messages, base)
      if (rewritten) out = { ...event, messages: rewritten }
    } else if (event.type === 'part') {
      const rewritten = rewriteMediaPart(event.part, base)
      if (rewritten) out = { ...event, part: rewritten }
    }
    client.ws.send(wrap({ type: 'chat:event', event: out } as CompanionEvent))
  }
}

/** Relays a RoutineEvent to every authenticated companion. */
export function forwardRoutineEvent(event: RoutineEvent): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'routines:event', event } as CompanionEvent))
  }
}

/** Relays a PipelineEvent to every authenticated companion. */
export function forwardPipelineEvent(event: PipelineEvent): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'pipeline:event', event } as CompanionEvent))
  }
}

/** Pushes the per-session model map (renderer → main) to every
 *  companion — it keeps the mobile on the SAME model per chat as the desktop. */
export function broadcastSessionModels(
  overrides: Record<string, { providerId: string; modelId: string }>,
): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'session:model-change', overrides } as unknown as CompanionEvent))
  }
}

/** Rotation state (list + choice per chat) pushed to the companions —
 *  without it the phone would open without the rotations created on the desktop. */
export function broadcastRotationConfig(config: RotationConfig): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'rotation:change', config } satisfies RotationChangeEvent))
  }
}

/** Same idea as broadcastSessionModels, for the modes active per chat
 *  (research, browser, plan, subagents, orchestration, vision, simple and
 *  brain) — without this the phone opens every chat on its own defaults. */
export function broadcastSessionModes(overrides: SessionModeOverrides): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'session:mode-change', overrides } satisfies SessionModeChangeEvent))
  }
}

/** Per-chat thinking and autonomy (sessionId → preference) pushed to the
 *  companions — without it the phone would open every chat on the device defaults. */
export function broadcastSessionPrefs(prefs: SessionPrefsSnapshot): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'session:prefs-change', prefs } satisfies SessionPrefsChangeEvent))
  }
}

/** Last queue pushed by the renderer — the phone's 'queue:get' on connecting. */
let messageQueueCache: MessageQueueSnapshot = {}

/** Renderer message queue, pushed to the companions on every change. The
 *  attachments go without the content: the phone only shows that they exist, and a photo as
 *  a data URL would cross the network on every queue edit. */
export function broadcastMessageQueue(queues: MessageQueueSnapshot): void {
  const leve: MessageQueueSnapshot = {}
  for (const [sessionId, items] of Object.entries(queues)) {
    leve[sessionId] = items.map((m) =>
      m.files?.length ? { ...m, files: m.files.map((f) => ({ ...f, url: '' })) } : m,
    )
  }
  messageQueueCache = leve
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'queue:change', queues: leve } satisfies MessageQueueChangeEvent))
  }
}

/** Thinking per model (toggle + variant) pushed to the companions — without it
 *  the mobile opens every chat with its own default thinking. */
export function broadcastReasoningPrefs(prefs: ReasoningPrefsMap): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'reasoning:change', prefs } satisfies ReasoningPrefsChangeEvent))
  }
}

/** Configuration of the delegated modes (subagent/orchestration workers and
 *  vision) — global, not per chat. */
export function broadcastWorkerConfig(config: WorkerConfigSnapshot): void {
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(wrap({ type: 'worker-config:change', config } satisfies WorkerConfigChangeEvent))
  }
}

/** Snapshot of the app preferences, pushed by the renderer. The cache here
 *  serves the 'prefs:get' of whoever connects after the last change. */
let appPreferences: AppPreferences | null = null

export function getAppPreferences(): AppPreferences | null {
  return appPreferences
}

/** Preferences changed on the desktop → mirrors them on every companion. */
export function broadcastAppPreferences(prefs: AppPreferences): void {
  appPreferences = prefs
  // Turns in progress that follow the selector read from here on every tool.
  setGlobalMode(prefs.permissionMode)
  const payload = wrap({ type: 'prefs:change', prefs } satisfies AppPreferencesChangeEvent)
  for (const client of clients) {
    if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) continue
    client.ws.send(payload)
  }
}

/**
 * Notifies the companion about a pending permission/question.
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
 * Notifies the companion about a new assistant message.
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

  wsBindError = null

  // If the bind fails (e.g. port 3847 already taken by another Orbit instance),
  // it marks the error and takes the wss down — otherwise the UI would show a phantom
  // "active" server (wss !== null) that nobody can reach.
  server.on('error', (err: Error) => {
    console.error('[Companion] WS server error:', err)
    wsBindError = err.message
    try { wss?.close() } catch { /* ignore */ }
    try { server?.close() } catch { /* ignore */ }
    wss = null
    server = null
  })

  regeneratePin()

  // Starts the REST HTTP server along with the WS
  startCompanionHttpServer(validatePin, getPairingPin, validateDeviceToken)

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const client: ConnectedClient = {
      ws,
      authenticated: false,
      deviceName: '',
      connectedAt: Date.now(),
      mediaHost: clientHostFromReq(req),
    }
    clients.add(client)

    console.log(`[Companion] New connection from ${getIp(ws)}`)

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage
        if (msg.payload && typeof (msg.payload as { type?: unknown }).type === 'string') {
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
  // Stop the HTTP server
  stopCompanionHttpServer()

  // Stop the WS server
  for (const client of clients) {
    client.ws.close()
  }
  clients.clear()
  wss?.close()
  server?.close()
  wss = null
  server = null
  wsBindError = null
}

export function getCompanionStatus() {
  return {
    running: wss !== null,
    port: PORT,
    httpPort: COMPANION_HTTP_PORT,
    httpRunning: isCompanionHttpRunning(),
    ip: getLocalIp(),
    pin: wss ? getCurrentPin() : currentPin,
    bindError: wsBindError,
    connectedClients: [...clients].filter(c => c.authenticated).map(c => ({
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
    })),
  }
}
