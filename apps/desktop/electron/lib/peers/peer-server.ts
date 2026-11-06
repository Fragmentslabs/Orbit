import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { app } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'
import {
  PEER_PROTOCOL_VERSION,
  isPeerId,
  normalizeGrants,
  type IncomingPairRequest,
  type PeerGrants,
  type PeerPairDeclineReason,
  type PeerPairServerMessage,
} from '@shared/peers'
import type { PeerIdentity } from './identity'
import { PendingPairs, isNonce, newNonce, pairingCode, sanitizePeerName } from './pairing'
import { remoteFingerprint, serverTlsOptions } from './tls-options'
import { attachDesktopClient, registerDesktopDevice, validateDesktopToken } from '../companion-server'
import { serveAsset } from '../companion-assets'
import { createAssetToken, isAssetScope } from '../companion-token'

/**
 * The mutual-TLS server desktops talk to (HTTPS + WSS on one port).
 *
 * A connection says who it is in its first message, within a few seconds:
 *
 * - `peer:auth` — a desktop already paired. Valid only with its token AND the
 *   client certificate it paired with. Then it becomes a companion client with the
 *   desktop allowlist (companion-server's attachDesktopClient).
 * - `peer:pair-request` — a desktop asking to pair. Only while this machine is
 *   discoverable. It becomes a card for the person here; the code on the card is
 *   derived from both certificates (see pairing.ts) and the requester shows the same.
 *
 * HTTP serves only the files of pieces and media (`/peer/file/<scope>/<id>/…`),
 * to paired desktops, with the same certificate + token check.
 */

const AUTH_TIMEOUT_MS = 10_000
const MAX_PAYLOAD = 2 * 1024 * 1024

interface PendingPayload {
  ws: WebSocket
  name: string
  requesterNonce: string
  responderNonce: string
  code: string
}

interface PeerServerOptions {
  identity: PeerIdentity
  port: number
  selfName: () => string
  isDiscoverable: () => boolean
  /** Incoming requests or devices changed — the UI refreshes. */
  onChange: () => void
}

let server: https.Server | null = null
let wss: WebSocketServer | null = null
let options: PeerServerOptions | null = null
let serverError: string | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
const pending = new PendingPairs<PendingPayload>()
const authFailures = new Map<string, number[]>()

function ipOf(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')
}

function tooManyFailures(ip: string): boolean {
  const now = Date.now()
  const recent = (authFailures.get(ip) ?? []).filter((t) => now - t < 60_000)
  authFailures.set(ip, recent)
  return recent.length >= 10
}

function noteFailure(ip: string): void {
  const list = authFailures.get(ip) ?? []
  list.push(Date.now())
  authFailures.set(ip, list)
}

function sendJson(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function decline(ws: WebSocket, reason: PeerPairDeclineReason): void {
  sendJson(ws, { type: 'peer:pair-declined', reason } satisfies PeerPairServerMessage)
  setTimeout(() => ws.close(4000, reason), 200)
}

function handleConnection(ws: WebSocket, req: IncomingMessage): void {
  const opts = options
  if (!opts) return ws.close()
  const ip = ipOf(req)
  const fingerprint = remoteFingerprint(req.socket as TLSSocket)
  if (!fingerprint || tooManyFailures(ip)) {
    ws.close(4003, 'refused')
    return
  }
  const timer = setTimeout(() => ws.close(4008, 'timeout'), AUTH_TIMEOUT_MS)

  ws.once('message', async (data: Buffer) => {
    clearTimeout(timer)
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      noteFailure(ip)
      return ws.close(4002, 'invalid')
    }

    if (msg.type === 'peer:auth') {
      const device = await validateDesktopToken(typeof msg.token === 'string' ? msg.token : '', fingerprint)
      if (!device) {
        noteFailure(ip)
        sendJson(ws, { type: 'peer:auth-error', reason: 'revoked' })
        setTimeout(() => ws.close(4001, 'revoked'), 200)
        return
      }
      sendJson(ws, {
        type: 'peer:auth-ok',
        peerId: opts.identity.peerId,
        name: opts.selfName(),
        version: app.getVersion(),
        protocolVersion: PEER_PROTOCOL_VERSION,
        grants: device.grants,
      })
      attachDesktopClient(ws, { deviceId: device.deviceId, deviceName: device.deviceName, grants: device.grants, host: ip })
      opts.onChange()
      ws.on('close', () => opts.onChange())
      return
    }

    if (msg.type === 'peer:pair-request') {
      if (!opts.isDiscoverable()) return decline(ws, 'not_discoverable')
      if (msg.protocolVersion !== PEER_PROTOCOL_VERSION) return decline(ws, 'version')
      if (!isPeerId(msg.peerId) || !isNonce(msg.nonce) || msg.peerId === opts.identity.peerId) {
        noteFailure(ip)
        return decline(ws, 'invalid')
      }
      const requesterNonce = msg.nonce
      const responderNonce = newNonce()
      const code = pairingCode({
        requesterFingerprint: fingerprint,
        responderFingerprint: opts.identity.fingerprint,
        requesterNonce,
        responderNonce,
      })
      const added = pending.add({
        peerId: msg.peerId,
        fingerprint,
        ip,
        payload: { ws, name: sanitizePeerName(msg.name), requesterNonce, responderNonce, code },
      })
      if (!added.ok) return decline(ws, added.reason)
      if (added.replaced) decline(added.replaced.payload.ws, 'expired')
      sendJson(ws, {
        type: 'peer:pair-pending',
        requestId: added.item.requestId,
        nonce: responderNonce,
        name: opts.selfName(),
        peerId: opts.identity.peerId,
        expiresAt: added.item.expiresAt,
      } satisfies PeerPairServerMessage)
      ws.on('close', () => {
        // The requester gave up (closed the modal): the card goes away.
        const current = pending.list().find((p) => p.requestId === added.item.requestId)
        if (current && current.payload.ws === ws) {
          pending.remove(added.item.requestId)
          opts.onChange()
        }
      })
      opts.onChange()
      return
    }

    noteFailure(ip)
    ws.close(4002, 'invalid')
  })
}

/** `/peer/file/<scope>/<id>/<rest>` — the pieces' and media files, for paired desktops. */
async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = ipOf(req)
  const url = req.url ?? '/'
  const match = /^\/peer\/file\/([a-z]+)\/([^/?#]+)(?:\/([^?#]*))?(?:[?#].*)?$/.exec(url)
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !match || !isAssetScope(match[1])) {
    res.writeHead(404).end()
    return
  }
  if (tooManyFailures(ip)) {
    res.writeHead(429).end()
    return
  }
  const auth = req.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const device = await validateDesktopToken(token, remoteFingerprint(req.socket as TLSSocket), { touch: false })
  if (!device) {
    noteFailure(ip)
    res.writeHead(401).end()
    return
  }
  let id: string
  try {
    id = decodeURIComponent(match[2])
  } catch {
    res.writeHead(404).end()
    return
  }
  const scope = match[1]
  // The internal token only satisfies serveAsset's contract: the authorization
  // here is the certificate + device token, checked above.
  await serveAsset(req, res, scope, id, createAssetToken(scope, id), match[3] ?? '', { rewriteFonts: false })
}

export function startPeerServer(opts: PeerServerOptions): void {
  if (server) return
  options = opts
  serverError = null
  server = https.createServer(serverTlsOptions(opts.identity), (req, res) => {
    void handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD })
  wss.on('connection', handleConnection)
  server.on('error', (err: Error) => {
    console.error('[Peers] server error:', err)
    serverError = err.message
    try {
      wss?.close()
      server?.close()
    } catch {
      /* ignore */
    }
    wss = null
    server = null
    opts.onChange()
  })
  server.listen(opts.port, '0.0.0.0', () => console.log(`[Peers] mutual-TLS server on ${opts.port}`))
  sweepTimer = setInterval(() => {
    const expired = pending.sweep()
    for (const item of expired) decline(item.payload.ws, 'expired')
    if (expired.length) opts.onChange()
  }, 2000)
}

export function stopPeerServer(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
  for (const item of pending.list()) decline(item.payload.ws, 'expired')
  wss?.close()
  server?.close()
  wss = null
  server = null
}

export function peerServerError(): string | null {
  return serverError
}

export function listIncomingRequests(): IncomingPairRequest[] {
  return pending.list().map((p) => ({
    requestId: p.requestId,
    peerId: p.peerId,
    name: p.payload.name,
    address: p.ip,
    code: p.payload.code,
    expiresAt: p.expiresAt,
  }))
}

export async function acceptIncomingRequest(requestId: string, grants: PeerGrants): Promise<boolean> {
  const item = pending.take(requestId)
  if (!item || !options) return false
  const clean = normalizeGrants(grants)
  const token = await registerDesktopDevice({
    deviceName: item.payload.name,
    peerId: item.peerId,
    fingerprint: item.fingerprint,
    grants: clean,
  })
  sendJson(item.payload.ws, {
    type: 'peer:pair-accepted',
    token,
    grants: clean,
    peerId: options.identity.peerId,
    name: options.selfName(),
  } satisfies PeerPairServerMessage)
  setTimeout(() => item.payload.ws.close(1000, 'paired'), 300)
  options.onChange()
  return true
}

export function declineIncomingRequest(requestId: string): boolean {
  const item = pending.take(requestId)
  if (!item) return false
  decline(item.payload.ws, 'declined')
  options?.onChange()
  return true
}

/** Discoverable turned off: nobody keeps waiting on a card that cannot be accepted. */
export function declineAllIncoming(): void {
  for (const item of pending.list()) {
    pending.remove(item.requestId)
    decline(item.payload.ws, 'not_discoverable')
  }
  options?.onChange()
}
