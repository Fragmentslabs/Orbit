import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Escopo da conversa atual para a resolução de provedores.
 *
 * Alguns provedores exigem um identificador estável da conversa em todas as
 * requisições (ex: o header `x-opencode-session` do OpenCode Go). O
 * `resolveModel` é chamado em dezenas de pontos — turno de chat, orquestrador,
 * esteira, ferramentas aninhadas (visão, question, workers) — e a maioria deles
 * não recebe o sessionId por parâmetro. Em vez de propagar o id por toda a
 * árvore de chamadas, os pontos de entrada de cada fluxo abrem este escopo e o
 * `resolveModel` o lê de dentro, inclusive nas chamadas aninhadas.
 */
const storage = new AsyncLocalStorage<string>()

/** Executa `fn` com `sessionId` como conversa corrente (no-op se indefinido). */
export function withProviderSession<T>(sessionId: string | undefined, fn: () => T): T {
  if (!sessionId) return fn()
  return storage.run(sessionId, fn)
}

/** Id da conversa corrente, se houver um escopo aberto. */
export function currentProviderSession(): string | undefined {
  return storage.getStore()
}
