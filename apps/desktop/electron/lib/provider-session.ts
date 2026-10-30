import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Scope of the current conversation for provider resolution.
 *
 * Some providers require a stable identifier of the conversation in all the
 * requests (e.g. OpenCode Go's `x-opencode-session` header). The
 * `resolveModel` is called from dozens of places — chat turn, orchestrator,
 * pipeline, nested tools (vision, question, workers) — and most of them
 * do not receive the sessionId as a parameter. Instead of propagating the id through the whole
 * call tree, each flow's entry points open this scope and
 * `resolveModel` reads it from inside, including in the nested calls.
 */
const storage = new AsyncLocalStorage<string>()

/** Runs `fn` with `sessionId` as the current conversation (no-op if undefined). */
export function withProviderSession<T>(sessionId: string | undefined, fn: () => T): T {
  if (!sessionId) return fn()
  return storage.run(sessionId, fn)
}

/** Id of the current conversation, if a scope is open. */
export function currentProviderSession(): string | undefined {
  return storage.getStore()
}
