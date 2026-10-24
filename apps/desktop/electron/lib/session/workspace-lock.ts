import { AsyncLocalStorage } from 'node:async_hooks'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Trava por PASTA DE TRABALHO (workspace).
 *
 * O snapshot do modo código é da pasta inteira: `capture` no começo do turno,
 * `capture` no fim e a transição S/E/C no revert. Dois turnos do Orbit na
 * MESMA pasta — duas conversas abertas no mesmo projeto, uma rotina e um chat,
 * orquestrador e worker — escrevem um no diff do outro: o `start` de um pode
 * sair no meio da escrita do outro e o revert de um leva junto o trabalho do
 * outro (foi exatamente o buraco encontrado na auditoria do revert).
 *
 * Aqui os turnos da mesma pasta são serializados: o segundo espera o primeiro
 * terminar. Pastas diferentes seguem em paralelo.
 *
 * REENTRÂNCIA. Um turno pode disparar outro turno na mesma pasta dentro do
 * próprio contexto assíncrono — subchat, worker da orquestra, loop. Esses são
 * parte do MESMO trabalho lógico e não podem esperar por si mesmos (deadlock);
 * o AsyncLocalStorage marca a pasta já adquirida e a chamada aninhada passa
 * direto. É o mesmo critério do `comTrava` do git, mas por turno e não por
 * comando.
 *
 * A chave é o `realpath` (symlinks resolvidos) e, no Windows, em caixa baixa:
 * `C:\Proj` e `c:\proj` são a mesma pasta.
 */
const held = new AsyncLocalStorage<Set<string>>()
const queues = new Map<string, Promise<void>>()
const keyCache = new Map<string, string>()

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
  const key = await workspaceKey(directory)
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

/** Há um turno na fila ou rodando nesta pasta? (diagnóstico e teste) */
export function workspaceLockPending(directory: string): boolean {
  return queues.has(path.resolve(directory))
}

/** Só para teste: zera filas e cache entre casos. */
export function __resetWorkspaceLocks(): void {
  queues.clear()
  keyCache.clear()
}
