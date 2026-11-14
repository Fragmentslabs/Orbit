/**
 * Request/response correlation plus the offline queue.
 *
 * - online: the message is written at once and waits for the `api:response` that
 *   carries the same id, up to `requestTimeoutMs`;
 * - offline: the message waits in a queue up to `queueTimeoutMs` (it is flushed in
 *   order on reconnect). The deadline matters: without it a "create chat" + "send"
 *   from minutes ago would fire suddenly when the link returns.
 */

import type { ApiResponse, WsMessage } from '@orbit/shared'

export interface RequestTrackerOptions {
  requestTimeoutMs: number
  queueTimeoutMs: number
  isOnline: () => boolean
  /** Writes a message to the socket; throws when it cannot. */
  transmit: (msg: WsMessage) => void
}

interface Entry {
  msg: WsMessage
  resolve: (v: ApiResponse) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RequestTracker {
  private inFlight = new Map<string, Entry>()
  private queued: Entry[] = []

  constructor(private readonly o: RequestTrackerOptions) {}

  submit(msg: WsMessage): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      if (this.o.isOnline()) {
        this.dispatch({ msg, resolve, reject, timer: undefined as never })
        return
      }
      const entry: Entry = {
        msg,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.queued = this.queued.filter((q) => q !== entry)
          reject(new Error(`Request ${msg.payload.type} timed out (offline)`))
        }, this.o.queueTimeoutMs),
      }
      this.queued.push(entry)
    })
  }

  /** Delivers an `api:response` to whoever is waiting for it. */
  resolve(res: ApiResponse): void {
    const entry = this.inFlight.get(res.requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.inFlight.delete(res.requestId)
    entry.resolve(res)
  }

  /** Back online: sends what waited, in order. */
  flush(): void {
    const queue = this.queued
    this.queued = []
    for (const entry of queue) {
      clearTimeout(entry.timer)
      if (this.o.isOnline()) this.dispatch(entry)
      else entry.reject(new Error('Connection lost before queue flush'))
    }
  }

  /** The socket went away: what was already sent will never be answered. */
  failInFlight(reason: string): void {
    for (const entry of this.inFlight.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.inFlight.clear()
  }

  failQueued(reason: string): void {
    const queue = this.queued
    this.queued = []
    for (const entry of queue) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
  }

  private dispatch(entry: Entry): void {
    const { msg } = entry
    entry.timer = setTimeout(() => {
      this.inFlight.delete(msg.id)
      entry.reject(new Error(`Request ${msg.payload.type} timed out`))
    }, this.o.requestTimeoutMs)
    this.inFlight.set(msg.id, entry)
    try {
      this.o.transmit(msg)
    } catch (err) {
      clearTimeout(entry.timer)
      this.inFlight.delete(msg.id)
      entry.reject(new Error(`Failed to send: ${err}`))
    }
  }
}
