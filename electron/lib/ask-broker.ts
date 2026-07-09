/**
 * AskBroker: registro único de perguntas pendentes do main para a UI.
 * Serve os dois recursos que aguardam resposta humana — pedidos de permissão
 * (toolApproval) e a tool question. O requester emite o ChatEvent do pedido,
 * aguarda aqui, e emite "ask:done" ao terminar (resposta OU rejeição).
 */

export class AskRejectedError extends Error {
  constructor(reason = 'pedido cancelado') {
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
 * Registra um pedido e aguarda a resposta da UI (via reply). O signal da
 * sessão rejeita no abort — o requester traduz em negação/dispensa.
 */
export function ask<T>(sessionId: string, requestId: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AskRejectedError('sessão abortada'))
      return
    }
    pending.set(requestId, { sessionId, resolve: resolve as (v: unknown) => void, reject })
    signal?.addEventListener(
      'abort',
      () => {
        const entry = pending.get(requestId)
        if (entry) {
          pending.delete(requestId)
          entry.reject(new AskRejectedError('sessão abortada'))
        }
      },
      { once: true },
    )
  })
}

/** Resolvido pelo IPC chat:askReply. Retorna false se o pedido já não existe. */
export function reply(requestId: string, value: unknown): boolean {
  const entry = pending.get(requestId)
  if (!entry) return false
  pending.delete(requestId)
  entry.resolve(value)
  return true
}

/** Rejeita todos os pedidos pendentes de uma sessão (abort/erro/delete). */
export function rejectSession(sessionId: string, reason = 'sessão encerrada'): void {
  for (const [requestId, entry] of pending) {
    if (entry.sessionId !== sessionId) continue
    pending.delete(requestId)
    entry.reject(new AskRejectedError(reason))
  }
}
