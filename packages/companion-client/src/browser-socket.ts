/**
 * Adapts the platform `WebSocket` (React Native / browser) to the core's `CoreSocket`.
 */

import type { CoreSocket, SocketEvents } from './connection-core'

export function openBrowserSocket(url: string, events: SocketEvents): CoreSocket {
  const ws = new WebSocket(url)
  ws.onopen = () => events.open()
  ws.onmessage = (e) => events.message(typeof e.data === 'string' ? e.data : String(e.data))
  ws.onclose = (e) => events.close((e as { code?: number }).code)
  ws.onerror = (e) => events.error(e)
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
    isConnecting: () => ws.readyState === WebSocket.CONNECTING,
  }
}
