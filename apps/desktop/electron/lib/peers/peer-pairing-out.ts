import type { TLSSocket } from 'node:tls'
import { WebSocket } from 'ws'
import {
  PEER_PROTOCOL_VERSION,
  isPeerId,
  normalizeGrants,
  type OutgoingPairState,
  type PeerPairServerMessage,
} from '@shared/peers'
import { fingerprintOf } from './identity'
import { newNonce, pairingCode, sanitizePeerName } from './pairing'
import { firstContactClientTlsOptions, remoteCertificatePem, remoteFingerprint } from './tls-options'
import { PeerConnection } from './peer-connection'
import { ctx, encryptToken, persist, type StoredPeer } from './peer-state'

/** Outgoing pairing: this machine asks another desktop to trust it. */

let outgoing: { state: OutgoingPairState; ws: WebSocket | null } | null = null

export function outgoingState(): OutgoingPairState | null {
  return outgoing?.state ?? null
}

// ─── Outgoing pairing ───────────────────────────────────────────────────────

function setOutgoing(state: OutgoingPairState | null): void {
  if (!state) outgoing = null
  else if (outgoing) outgoing.state = state
  else outgoing = { state, ws: null }
  ctx.hooks?.changed()
}

export function cancelPairing(): void {
  const ws = outgoing?.ws
  outgoing = null
  try {
    ws?.close()
  } catch {
    /* already closed */
  }
  ctx.hooks?.changed()
}

export function startPairing(host: string, port: number): void {
  if (!ctx.identity) return
  cancelPairing()
  const me = ctx.identity
  const requesterNonce = newNonce()
  let serverPem: string | null = null
  let serverFp: string | null = null
  let finished = false
  const state: OutgoingPairState = { host, port, status: 'connecting' }
  outgoing = { state, ws: null }
  ctx.hooks?.changed()

  const ws = new WebSocket(`wss://${host}:${port}`, { ...firstContactClientTlsOptions(me), handshakeTimeout: 8000 })
  outgoing.ws = ws
  const isCurrent = () => outgoing?.ws === ws

  ws.on('upgrade', (res) => {
    serverPem = remoteCertificatePem(res.socket as TLSSocket)
    serverFp = remoteFingerprint(res.socket as TLSSocket)
  })
  ws.on('open', () => {
    if (!serverPem || !serverFp) {
      ws.close()
      return
    }
    ws.send(JSON.stringify({ type: 'peer:pair-request', protocolVersion: PEER_PROTOCOL_VERSION, peerId: me.peerId, name: ctx.selfName(), nonce: requesterNonce }))
  })
  ws.on('message', async (data: Buffer) => {
    if (!isCurrent()) return
    let msg: PeerPairServerMessage
    try {
      msg = JSON.parse(data.toString()) as PeerPairServerMessage
    } catch {
      return
    }
    if (msg.type === 'peer:pair-pending' && serverFp) {
      const code = pairingCode({
        requesterFingerprint: me.fingerprint,
        responderFingerprint: serverFp,
        requesterNonce,
        responderNonce: msg.nonce,
      })
      setOutgoing({ host, port, status: 'waiting', code, name: sanitizePeerName(msg.name), expiresAt: msg.expiresAt })
    } else if (msg.type === 'peer:pair-accepted' && serverPem && isPeerId(msg.peerId)) {
      finished = true
      // The certificate we pin is the one THIS TLS session presented — the same one the
      // code was computed from — never anything the message says.
      if (fingerprintOf(serverPem) !== serverFp) return setOutgoing({ host, port, status: 'error', reason: 'invalid' })
      const peer: StoredPeer = {
        peerId: msg.peerId,
        name: sanitizePeerName(msg.name),
        host,
        port,
        cert: serverPem,
        ...encryptToken(msg.token),
        grants: normalizeGrants(msg.grants),
        pairedAt: Date.now(),
      }
      ctx.connections.get(peer.peerId)?.close()
      ctx.httpClients.delete(peer.peerId)
      ctx.stored = [...ctx.stored.filter((p) => p.peerId !== peer.peerId), peer]
      await persist()
      const conn = new PeerConnection(peer)
      ctx.connections.set(peer.peerId, conn)
      setOutgoing({ host, port, status: 'accepted', name: peer.name })
      setTimeout(() => conn.connect(), 400)
    } else if (msg.type === 'peer:pair-declined') {
      finished = true
      setOutgoing({ host, port, status: msg.reason === 'expired' ? 'expired' : 'declined', reason: msg.reason, name: outgoing?.state.name })
    }
  })
  ws.on('error', () => {
    if (!isCurrent() || finished) return
    finished = true
    setOutgoing({ host, port, status: 'error', reason: 'unreachable' })
  })
  ws.on('close', () => {
    if (!isCurrent() || finished) return
    finished = true
    setOutgoing({ host, port, status: 'error', reason: 'unreachable' })
  })
}
