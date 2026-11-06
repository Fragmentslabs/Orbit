import os from 'node:os'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { ChatMessage } from '@shared/chat'
import {
  PEER_PORT,
  normalizeGrants,
  parseRemoteSessionId,
  type DiscoveredPeer,
  type PeersEvent,
  type PeersSnapshot,
  type RemoteFileContent,
  type RemoteFileTree,
  type RemotePieceKind,
  type RemotePieceRef,
  type RemotePieceResolved,
} from '@shared/peers'
import { dataDir, readJson, writeJson } from '../storage'
import { getLocalIp, listGrantedDevices, revokeDevice } from '../companion-server'
import { panelDesignPreview, panelMotionPreview, panelSlidesPreview } from '../panel-browser'
import { loadOrCreateIdentity, type PeerIdentity } from './identity'
import {
  acceptIncomingRequest,
  declineAllIncoming,
  declineIncomingRequest,
  listIncomingRequests,
  peerServerError,
  startPeerServer,
} from './peer-server'
import {
  cancelPairing,
  forgetPeer,
  initPeerClient,
  knownPeers,
  notePeerAddress,
  outgoingState,
  peerGrants,
  peerRequest,
  reconnectPeers,
  resendPeerSessions,
  runningOnPeers,
  startPairing,
} from './peer-client'
import { seenPeers, setDiscoverySelf, startAdvertising, startBrowsing, stopAdvertising, stopBrowsing } from './discovery'
import { indexRemoteIds, peerForAsset, rememberRemoteId } from './remote-index'
import { isRemoteAsset, remoteMotionProps } from './remote-assets'
import { sanitizePeerName } from './pairing'

/**
 * Orbit ↔ Orbit, wired into the main process: identity, the mutual-TLS server, the
 * connections to the paired desktops, discovery, and the IPCs of the renderer.
 *
 * Also the remote branch of the piece IPCs (`motion:open`, `design:readBoard`…):
 * main.ts asks here first, and only a namespaced session or an id that came from a
 * peer goes over the network — everything else stays exactly as it was.
 */

const DISCOVERABLE_KEY = 'peers/discoverable'

let identity: PeerIdentity | null = null
let listenPort = PEER_PORT
let discoverable = false
let browsingRefs = 0
let browseTimer: ReturnType<typeof setInterval> | null = null
let snapshotTimer: ReturnType<typeof setTimeout> | null = null

function selfName(): string {
  const host = os.hostname().replace(/\.local$/i, '')
  const profile = !app.isPackaged ? process.env.ORBIT_DEV_PROFILE : undefined
  return sanitizePeerName(profile ? `${host} (${profile})` : host)
}

function send(event: PeersEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('peers:event', event)
  }
}

function discoveredList(): DiscoveredPeer[] {
  if (!browsingRefs) return []
  const known = new Set(knownPeers().map((p) => p.peerId))
  return seenPeers().map((p) => ({ peerId: p.peerId, name: p.name, host: p.host, port: p.port, version: p.version, paired: known.has(p.peerId) }))
}

async function snapshot(): Promise<PeersSnapshot> {
  return {
    discoverable,
    selfName: selfName(),
    selfPeerId: identity?.peerId ?? '',
    selfAddress: { ip: getLocalIp(), port: listenPort },
    peers: knownPeers(),
    discovered: discoveredList(),
    incoming: listIncomingRequests(),
    outgoing: outgoingState(),
    running: runningOnPeers(),
    devices: await listGrantedDevices(),
    serverError: peerServerError(),
  }
}

function changed(): void {
  if (snapshotTimer) return
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null
    send({ type: 'snapshot', snapshot: await snapshot() })
  }, 120)
}

function applyDiscoverable(): void {
  if (!identity) return
  if (discoverable) {
    const me = identity
    startAdvertising(() => ({ peerId: me.peerId, name: selfName(), port: listenPort, version: app.getVersion() }))
  } else {
    stopAdvertising()
    declineAllIncoming()
  }
}

function onSeen(): void {
  for (const p of seenPeers()) notePeerAddress(p.peerId, p.host, p.port)
  changed()
}

export async function startPeers(): Promise<void> {
  try {
    identity = loadOrCreateIdentity(dataDir())
  } catch (err) {
    console.error('[Peers] could not create the identity:', err)
    return
  }
  discoverable = (await readJson<boolean>(DISCOVERABLE_KEY)) === true
  setDiscoverySelf(identity.peerId, onSeen)
  // ORBIT_PEER_PORT (dev only): a second instance on the same machine needs its own port.
  const devPort = !app.isPackaged ? Number(process.env.ORBIT_PEER_PORT) : NaN
  const port = Number.isInteger(devPort) && devPort > 0 && devPort < 65536 ? devPort : PEER_PORT
  listenPort = port
  startPeerServer({ identity, port, selfName, isDiscoverable: () => discoverable, onChange: changed })
  await initPeerClient({ identity, selfName, hooks: { emit: send, changed } })
  applyDiscoverable()
}

function remote(sessionId: unknown): { peerId: string; sessionId: string } {
  const parsed = typeof sessionId === 'string' ? parseRemoteSessionId(sessionId) : null
  if (!parsed) throw new Error('not_a_remote_session')
  return parsed
}

export function registerPeersIpc(): void {
  ipcMain.handle('peers:snapshot', () => snapshot())
  ipcMain.handle('peers:setDiscoverable', async (_e, value: boolean) => {
    discoverable = value === true
    await writeJson(DISCOVERABLE_KEY, discoverable)
    applyDiscoverable()
    changed()
  })
  ipcMain.handle('peers:browse', (_e, on: boolean) => {
    browsingRefs = Math.max(0, browsingRefs + (on ? 1 : -1))
    if (browsingRefs > 0) {
      startBrowsing()
      if (!browseTimer) browseTimer = setInterval(changed, 2000)
    } else {
      stopBrowsing()
      if (browseTimer) clearInterval(browseTimer)
      browseTimer = null
    }
    changed()
  })
  ipcMain.handle('peers:pair', (_e, host: string, port?: number) => {
    const h = typeof host === 'string' ? host.trim() : ''
    if (!h || h.length > 255 || /[\s/@]/.test(h)) throw new Error('invalid_address')
    const p = typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : PEER_PORT
    startPairing(h, p)
  })
  ipcMain.handle('peers:cancelPair', () => cancelPairing())
  ipcMain.handle('peers:accept', (_e, requestId: string, grants: unknown) => acceptIncomingRequest(String(requestId), normalizeGrants(grants)))
  ipcMain.handle('peers:decline', (_e, requestId: string) => declineIncomingRequest(String(requestId)))
  ipcMain.handle('peers:forget', (_e, peerId: string) => forgetPeer(String(peerId)))
  ipcMain.handle('peers:revokeDevice', async (_e, id: string) => {
    const ok = await revokeDevice(String(id))
    changed()
    return ok
  })
  ipcMain.handle('peers:reconnect', () => reconnectPeers())
  ipcMain.handle('peers:resend', (_e, peerId?: string) => resendPeerSessions(typeof peerId === 'string' ? peerId : undefined))

  ipcMain.handle('peers:messages', async (_e, sessionId: string, opts?: { limit?: number; offset?: number }) => {
    const r = remote(sessionId)
    const messages = await peerRequest<ChatMessage[]>(r.peerId, {
      type: 'messages:get',
      sessionId: r.sessionId,
      limit: Math.min(Math.max(opts?.limit ?? 60, 1), 100),
      offset: Math.max(opts?.offset ?? 0, 0),
    })
    return Array.isArray(messages) ? messages : []
  })
  ipcMain.handle('peers:sessionState', async (_e, sessionId: string) => {
    const r = remote(sessionId)
    return peerRequest(r.peerId, { type: 'session:state', sessionId: r.sessionId })
  })
  ipcMain.handle('peers:send', async (_e, sessionId: string, text: string) => {
    const r = remote(sessionId)
    if (!peerGrants(r.peerId).send) throw new Error('forbidden')
    return peerRequest(r.peerId, { type: 'messages:send', sessionId: r.sessionId, text: String(text ?? '') })
  })
  ipcMain.handle('peers:abort', async (_e, sessionId: string) => {
    const r = remote(sessionId)
    if (!peerGrants(r.peerId).send) throw new Error('forbidden')
    return peerRequest(r.peerId, { type: 'chat:abort', sessionId: r.sessionId })
  })
  ipcMain.handle('peers:fsTree', async (_e, sessionId: string, root?: number, rel?: string) => {
    const r = remote(sessionId)
    if (!peerGrants(r.peerId).files) throw new Error('forbidden')
    return peerRequest<RemoteFileTree>(r.peerId, { type: 'fs:tree', sessionId: r.sessionId, root: root ?? 0, path: rel ?? '' })
  })
  ipcMain.handle('peers:fsRead', async (_e, sessionId: string, root: number, rel: string) => {
    const r = remote(sessionId)
    if (!peerGrants(r.peerId).files) throw new Error('forbidden')
    return peerRequest<RemoteFileContent>(r.peerId, { type: 'fs:read', sessionId: r.sessionId, root, path: rel })
  })
}

// ─── Remote branch of the piece IPCs (main.ts) ──────────────────────────────

/** The peer behind a piece ref: a namespaced session, or an id that came from a peer. */
function peerOfRef(ref: { id?: string; sessionId?: string }): { peerId: string; namespaced?: string; remoteSession?: string } | null {
  const parsed = parseRemoteSessionId(ref.sessionId)
  if (parsed) return { peerId: parsed.peerId, namespaced: ref.sessionId, remoteSession: parsed.sessionId }
  if (ref.id && isRemoteAsset(ref.id)) {
    const peerId = peerForAsset(ref.id)
    if (peerId) return { peerId }
  }
  return null
}

async function resolveRemote(kind: RemotePieceKind, ref: RemotePieceRef & { sessionId?: string }) {
  const owner = peerOfRef(ref)
  if (!owner) return null
  const resolved = await peerRequest<RemotePieceResolved | null>(owner.peerId, {
    type: 'piece:resolve',
    kind,
    ref: { id: ref.id, path: ref.path, name: ref.name, sessionId: owner.remoteSession },
  }).catch(() => null)
  if (resolved?.id) rememberRemoteId(resolved.id, owner.peerId)
  return { owner, resolved }
}

/** `motion:open` / `design:open` / `slides:open` for a peer's piece; `null` = not remote. */
export async function openRemotePiece(kind: RemotePieceKind, ref: RemotePieceRef & { sessionId?: string }): Promise<boolean | null> {
  const r = await resolveRemote(kind, ref)
  if (!r) return null
  const { owner, resolved } = r
  if (!resolved) return false
  const sessionId = owner.namespaced
  if (kind === 'motion') panelMotionPreview({ id: resolved.id, entry: resolved.entry ?? 'index.html', title: resolved.title, sessionId })
  else if (kind === 'design') panelDesignPreview({ id: resolved.id, title: resolved.title, sessionId })
  else panelSlidesPreview({ id: resolved.id, entry: resolved.entry ?? 'index.html', title: resolved.title, sessionId })
  return true
}

/** `slides:resolve` for a peer's deck; `undefined` = not remote. */
export async function resolveRemoteSlides(ref: RemotePieceRef & { sessionId?: string }): Promise<{ id: string; entry: string } | null | undefined> {
  const r = await resolveRemote('slides', ref)
  if (!r) return undefined
  return r.resolved ? { id: r.resolved.id, entry: r.resolved.entry ?? 'index.html' } : null
}

export function isRemotePiece(id: unknown): boolean {
  return typeof id === 'string' && isRemoteAsset(id)
}

export async function remoteMotionPropsIpc(id: string) {
  return (await remoteMotionProps(id)) ?? { exists: false, schema: {}, errors: [] }
}

/** `motion:bundles` of a peer's chat; `null` = not remote. */
export async function remoteMotionBundles(sessionId: unknown): Promise<unknown[] | null> {
  const parsed = typeof sessionId === 'string' ? parseRemoteSessionId(sessionId) : null
  if (!parsed) return null
  const bundles = await peerRequest<unknown[]>(parsed.peerId, { type: 'piece:bundles', sessionId: parsed.sessionId }).catch(() => [])
  indexRemoteIds(parsed.peerId, bundles)
  return Array.isArray(bundles) ? bundles : []
}

export async function remoteDesignBoard(id: string, file: string): Promise<string> {
  const peerId = peerForAsset(id)
  if (!peerId) throw new Error('not_found')
  return peerRequest<string>(peerId, { type: 'design:board', id, file })
}

/** `document:source` / `document:info` of a peer's document; `null` when it is not one. */
export async function remoteDocument(kind: 'source' | 'info', id: string): Promise<unknown> {
  const peerId = peerForAsset(id)
  if (!peerId) return null
  return peerRequest(peerId, { type: kind === 'source' ? 'document:source' : 'document:info', id }).catch(() => null)
}

export async function remoteArtifactRead(id: string): Promise<string | null> {
  const peerId = peerForAsset(id)
  if (!peerId) return null
  return peerRequest<string | null>(peerId, { type: 'artifact:read', id }).catch(() => null)
}
