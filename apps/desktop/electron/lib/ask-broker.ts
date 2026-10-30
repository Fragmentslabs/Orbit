/**
 * AskBroker: single registry of pending questions from the main to the UI.
 * It serves both resources that wait for a human answer — permission requests
 * (toolApproval) and the question tool. The requester emits the request's ChatEvent,
 * waits here, and emits "ask:done" when it ends (answer OR rejection).
 */

export class AskRejectedError extends Error {
  constructor(reason = 'request cancelled') {
    super(reason)
    this.name = 'AskRejectedError'
  }
}

interface PendingAsk {
  sessionId: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

const pending = new Map<string, PendingAsk>()

export function newRequestId(): string {
  return `ask_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Registers a request and waits for the UI's answer (via reply). The session's
 * signal rejects on abort — the requester translates it into a denial/dismissal.
 */
export function ask<T>(sessionId: string, requestId: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AskRejectedError('session aborted'))
      return
    }
    pending.set(requestId, { sessionId, resolve: resolve as (v: unknown) => void, reject })
    signal?.addEventListener(
      'abort',
      () => {
        const entry = pending.get(requestId)
        if (entry) {
          pending.delete(requestId)
          entry.reject(new AskRejectedError('session aborted'))
        }
      },
      { once: true },
    )
  })
}

/** Resolved by the chat:askReply IPC. Returns false if the request no longer exists. */
export function reply(requestId: string, value: unknown): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  pending.delete(requestId)
  entry.resolve(value)
  return true
}

/** Rejects every pending request of a session (abort/error/delete). */
export function rejectSession(sessionId: string, reason = 'session closed'): void {
  for (const [requestId, entry] of pending) {
    if (entry.sessionId !== sessionId) continue
    pending.delete(requestId)
    entry.reject(new AskRejectedError(reason))
  }
}
