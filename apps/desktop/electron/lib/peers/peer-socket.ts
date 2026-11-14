import { WebSocket } from 'ws'
import type { CoreSocket, SocketEvents } from '@orbit/companion-client'
import type { PeerIdentity } from './identity'
import { pinnedClientTlsOptions } from './tls-options'

/**
 * Opens the pinned mutual-TLS WebSocket to a peer and adapts `ws` to the
 * connection core's socket interface.
 */
export function openPeerSocket(
  address: { host: string; port: number; cert: string },
  identity: PeerIdentity,
  events: SocketEvents,
): CoreSocket {
  const ws = new WebSocket(`wss://${address.host}:${address.port}`, {
    ...pinnedClientTlsOptions(identity, address.cert),
    handshakeTimeout: 8000,
    maxPayload: 64 * 1024 * 1024,
  })
  ws.on('open', () => events.open())
  ws.on('message', (data: Buffer) => events.message(data.toString()))
  ws.on('error', (err: Error) => events.error(err))
  ws.on('close', (code: number) => events.close(code))
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
    isConnecting: () => ws.readyState === WebSocket.CONNECTING,
  }
}
