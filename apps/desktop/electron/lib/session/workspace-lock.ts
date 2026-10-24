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
 * próprio contexto assíncrono e esperar por ele — worker da orquestra,
 * iteração do loop. Esses são parte do MESMO trabalho lógico e não podem
 * esperar por si mesmos (deadlock); o AsyncLocalStorage marca a pasta já
 * adquirida e a chamada aninhada passa direto. É o mesmo critério do
 * `comTrava` do git, mas por turno e não por comando. O que é disparado sem
 * `await` e vive além do turno (subchat) sai do contexto com
 * `outsideWorkspaceLocks` e entra na fila.
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

/**
 * Roda `fn` SEM herdar as pastas adquiridas pelo chamador.
 *
 * Para turnos disparados em paralelo e sem `await` — o subchat é outra
 * conversa, com revert próprio, e sobrevive ao turno do pai. Herdando o
 * contexto, ele passaria direto pela trava (reentrância) e continuaria
 * escrevendo na pasta depois que o pai a soltou, junto com o próximo turno da
 * fila. Fora do contexto, ele entra na fila como qualquer outro turno.
 */
export function outsideWorkspaceLocks<T>(fn: () => T): T {
  return held.exit(fn)
}

/**
 * Turnos esperando a pasta de outro turno, por sessão. Enquanto esperam, eles
 * ainda não têm o controller do engine — sem este registro, o botão de parar
 * não fazia nada e o turno rodava mesmo assim quando a pasta ficasse livre.
 */
const queuedTurns = new Map<string, Set<AbortController>>()

/**
 * `withWorkspaceLock` para um turno de conversa: registra o turno como
 * pendente (parável e visível como "rodando") desde a chegada até o fim. O
 * sinal entregue a `turn` aborta quando alguém pede para parar — na fila ou
 * já durante o turno.
 */
export async function queuedWorkspaceTurn<T>(
  sessionId: string,
  directory: string,
  turn: (queued: AbortSignal) => Promise<T>,
): Promise<T> {
  const queued = new AbortController()
  let pending = queuedTurns.get(sessionId)
  if (!pending) {
    pending = new Set()
    queuedTurns.set(sessionId, pending)
  }
  pending.add(queued)
  try {
    return await withWorkspaceLock(directory, () => turn(queued.signal))
  } finally {
    pending.delete(queued)
    if (pending.size === 0 && queuedTurns.get(sessionId) === pending) queuedTurns.delete(sessionId)
  }
}

/** Para os turnos da sessão que estão na fila (ou já rodando por ela). */
export function abortQueuedTurns(sessionId: string): void {
  for (const queued of queuedTurns.get(sessionId) ?? []) queued.abort()
}

/** Sessões com turno na fila da pasta ou rodando por ela. */
export function queuedTurnSessionIds(): string[] {
  return [...queuedTurns.keys()]
}

/** Liga o "parar" da fila ao controller do turno: parado antes, nasce abortado. */
export function linkQueuedAbort(queued: AbortSignal | undefined, controller: AbortController): void {
  if (!queued) return
  if (queued.aborted) controller.abort()
  else queued.addEventListener('abort', () => controller.abort(), { once: true })
}

/** Há um turno na fila ou rodando nesta pasta? (diagnóstico e teste) */
export function workspaceLockPending(directory: string): boolean {
  return queues.has(path.resolve(directory))
}

/** Só para teste: zera filas e cache entre casos. */
export function __resetWorkspaceLocks(): void {
  queues.clear()
  keyCache.clear()
  queuedTurns.clear()
  keyOrder = Promise.resolve()
}
