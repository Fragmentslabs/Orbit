import { AsyncLocalStorage } from 'node:async_hooks'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Trava CURTA por pasta de trabalho (workspace).
 *
 * Serializa as operações que leem o estado da pasta e mexem nele com base
 * nessa leitura — revert, unrevert e o revert dos caminhos de autor incerto:
 * dois reverts na mesma pasta não podem decidir em cima do mesmo estado e
 * pisar um no outro. NÃO segura o turno: a autoria do que um turno gravou vem
 * do diário de escrita das tools (write-journal.ts), então duas conversas na
 * mesma pasta rodam em paralelo.
 *
 * REENTRÂNCIA. Uma operação que já segura a pasta e chama outra que também a
 * pede passa direto (o AsyncLocalStorage marca a pasta adquirida) — senão
 * esperaria por si mesma.
 *
 * A chave é o `realpath` (symlinks resolvidos) e, no Windows, em caixa baixa:
 * `C:\Proj` e `c:\proj` são a mesma pasta.
 */
const held = new AsyncLocalStorage<Set<string>>()
const queues = new Map<string, Promise<void>>()
const keyCache = new Map<string, string>()
let keyOrder: Promise<void> = Promise.resolve()

async function workspaceKey(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  const cached = keyCache.get(resolved)
  if (cached) return cached
  let key = resolved
  try {
    key = await fsp.realpath(resolved)
  } catch {
    // Pasta que sumiu (worktree removido): a chave resolvida ainda serializa
    // as tentativas e o erro real aparece na captura.
  }
  if (process.platform === 'win32') key = key.toLowerCase()
  keyCache.set(resolved, key)
  return key
}

function contextoCom(key: string): Set<string> {
  // Herda o que o chamador já segura (reentrância entre pastas) e soma esta.
  const next = new Set(held.getStore() ?? [])
  next.add(key)
  return next
}

/**
 * Executa `fn` com a pasta adquirida. Se já estiver adquirida neste contexto
 * assíncrono, roda direto (reentrante); senão entra na fila da pasta.
 */
export async function withWorkspaceLock<T>(directory: string, fn: () => Promise<T> | T): Promise<T> {
  // As chaves saem na ordem das chamadas: o `realpath` é assíncrono, e sem a
  // corrente um turno que chegou depois (com o caminho já em cache, ou um
  // realpath mais rápido) entraria na fila na frente do que já esperava.
  const resolving = keyOrder.then(() => workspaceKey(directory))
  keyOrder = resolving.then(
    () => {},
    () => {},
  )
  const key = await resolving
  if (held.getStore()?.has(key)) return fn()

  const anterior = queues.get(key) ?? Promise.resolve()
  // `fn` nos dois ramos: uma falha de um turno não pode travar a pasta.
  const atual = anterior.then(
    () => held.run(contextoCom(key), async () => fn()),
    () => held.run(contextoCom(key), async () => fn()),
  )
  const cauda = atual.then(
    () => {},
    () => {},
  )
  queues.set(key, cauda)
  void cauda.then(() => {
    if (queues.get(key) === cauda) queues.delete(key)
  })
  return atual
}

/** Há uma operação na fila ou rodando nesta pasta? (diagnóstico e teste) */
export async function workspaceLockPending(directory: string): Promise<boolean> {
  return queues.has(await workspaceKey(directory))
}

/** Só para teste: zera filas e cache entre casos. */
export function __resetWorkspaceLocks(): void {
  queues.clear()
  keyCache.clear()
  keyOrder = Promise.resolve()
}
