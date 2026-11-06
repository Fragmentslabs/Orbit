import dgram from 'node:dgram'
import os from 'node:os'
import { PEER_BEACON_PORT, isPeerId } from '@shared/peers'
import { sanitizePeerName } from './pairing'

/**
 * Finding other Orbits on the network: a small UDP beacon, no dependency.
 *
 * - Advertising only happens while "Allow this computer to be found" is on.
 * - Listening only happens while someone is looking (the "Another computer" tab is
 *   open) — and listening exposes nothing.
 *
 * The beacon carries no secret: id, name, port and version. Who the machine really
 * is gets settled by the certificates during pairing; a forged beacon can at most
 * show a name in the list, and the codes would not match.
 */

const BEACON_EVERY_MS = 2000
const FORGET_AFTER_MS = 7000

export interface BeaconInfo {
  peerId: string
  name: string
  port: number
  version: string
}

export interface SeenPeer extends BeaconInfo {
  host: string
  lastSeen: number
}

interface BeaconMessage {
  app: 'orbit-peer'
  v: 1
  peerId: string
  name: string
  port: number
  version: string
}

export function parseBeacon(raw: Buffer | string, selfPeerId: string): BeaconInfo | null {
  if (raw.length > 1024) return null
  let msg: Partial<BeaconMessage>
  try {
    msg = JSON.parse(raw.toString()) as Partial<BeaconMessage>
  } catch {
    return null
  }
  if (msg.app !== 'orbit-peer' || msg.v !== 1) return null
  if (!isPeerId(msg.peerId) || msg.peerId === selfPeerId) return null
  if (typeof msg.port !== 'number' || !Number.isInteger(msg.port) || msg.port < 1 || msg.port > 65535) return null
  return {
    peerId: msg.peerId,
    name: sanitizePeerName(msg.name),
    port: msg.port,
    version: typeof msg.version === 'string' ? msg.version.slice(0, 32) : '',
  }
}

/** The broadcast address of every real IPv4 interface (`192.168.0.255`, …). */
export function broadcastAddresses(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      const ip = iface.address.split('.').map(Number)
      const mask = iface.netmask.split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      out.add(ip.map((part, i) => (part | (~mask[i] & 255)) & 255).join('.'))
    }
  }
  return [...out]
}

let socket: dgram.Socket | null = null
let advertiseTimer: ReturnType<typeof setInterval> | null = null
let advertising: (() => BeaconInfo) | null = null
let browsing = false
let selfId = ''
const seen = new Map<string, SeenPeer>()
let onSeenChange: (() => void) | null = null

function ensureSocket(): dgram.Socket | null {
  if (socket) return socket
  try {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    s.on('error', (err) => {
      console.warn('[Peers] beacon socket error:', err.message)
      closeSocket()
    })
    s.on('message', (msg, rinfo) => {
      if (!browsing) return
      const info = parseBeacon(msg, selfId)
      if (!info) return
      const before = seen.get(info.peerId)
      seen.set(info.peerId, { ...info, host: rinfo.address, lastSeen: Date.now() })
      if (!before || before.host !== rinfo.address || before.name !== info.name) onSeenChange?.()
    })
    s.bind(PEER_BEACON_PORT, () => {
      try {
        s.setBroadcast(true)
      } catch {
        /* some interfaces refuse; the unicast fallback (manual address) still works */
      }
    })
    socket = s
    return s
  } catch (err) {
    console.warn('[Peers] could not open the beacon socket:', (err as Error).message)
    return null
  }
}

function closeSocket(): void {
  try {
    socket?.close()
  } catch {
    /* already closed */
  }
  socket = null
}

function maybeClose(): void {
  if (!advertising && !browsing) closeSocket()
}

function sendBeacon(): void {
  const s = socket
  const info = advertising?.()
  if (!s || !info) return
  const payload = Buffer.from(JSON.stringify({ app: 'orbit-peer', v: 1, ...info } satisfies BeaconMessage))
  for (const address of broadcastAddresses()) {
    s.send(payload, PEER_BEACON_PORT, address, () => {})
  }
}

export function setDiscoverySelf(peerId: string, onChange: () => void): void {
  selfId = peerId
  onSeenChange = onChange
}

export function startAdvertising(info: () => BeaconInfo): void {
  advertising = info
  if (!ensureSocket()) return
  if (!advertiseTimer) {
    advertiseTimer = setInterval(sendBeacon, BEACON_EVERY_MS)
    setTimeout(sendBeacon, 300)
  }
}

export function stopAdvertising(): void {
  advertising = null
  if (advertiseTimer) clearInterval(advertiseTimer)
  advertiseTimer = null
  maybeClose()
}

export function startBrowsing(): void {
  browsing = true
  ensureSocket()
}

export function stopBrowsing(): void {
  browsing = false
  seen.clear()
  maybeClose()
}

export function seenPeers(): SeenPeer[] {
  const now = Date.now()
  for (const [id, peer] of seen) if (now - peer.lastSeen > FORGET_AFTER_MS) seen.delete(id)
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}
