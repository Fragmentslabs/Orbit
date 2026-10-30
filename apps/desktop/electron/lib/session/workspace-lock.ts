import { AsyncLocalStorage } from 'node:async_hooks'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * SHORT lock per working folder (workspace).
 *
 * Serializes the operations that read the folder state and change it based
 * on that read — revert, unrevert and the revert of the paths of uncertain
 * authorship: two reverts in the same folder cannot decide on the same state and
 * step on each other. It does NOT hold the turn: the authorship of what a turn wrote comes
 * from the write journal of the tools (write-journal.ts), so two conversations in
 * the same folder run in parallel.
 *
 * REENTRANCY. An operation that already holds the folder and calls another one that also
 * asks for it goes straight through (the AsyncLocalStorage marks the folder as acquired) —
 * otherwise it would wait for itself.
 *
 * The key is the `realpath` (symlinks resolved) and, on Windows, lowercased:
 * `C:\Proj` and `c:\proj` are the same folder.
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
    // Folder that vanished (removed worktree): the resolved key still serializes
    // the attempts and the real error shows up in the capture.
  }
  if (process.platform === 'win32') key = key.toLowerCase()
  keyCache.set(resolved, key)
  return key
}

function contextWith(key: string): Set<string> {
  // Inherits what the caller already holds (reentrancy across folders) and adds this one.
  const next = new Set(held.getStore() ?? [])
  next.add(key)
  return next
}

/**
 * Runs `fn` with the folder acquired. If it is already acquired in this async
 * context, it runs straight through (reentrant); otherwise it joins the folder queue.
 */
export async function withWorkspaceLock<T>(directory: string, fn: () => Promise<T> | T): Promise<T> {
  // The keys come out in call order: `realpath` is asynchronous, and without the
  // chain a turn that arrived later (with the path already cached, or a
  // faster realpath) would join the queue ahead of the one that was already waiting.
  const resolving = keyOrder.then(() => workspaceKey(directory))
  keyOrder = resolving.then(
    () => {},
    () => {},
  )
  const key = await resolving
  if (held.getStore()?.has(key)) return fn()

  const previous = queues.get(key) ?? Promise.resolve()
  // `fn` on both branches: a failure of one turn cannot jam the folder.
  const current = previous.then(
    () => held.run(contextWith(key), async () => fn()),
    () => held.run(contextWith(key), async () => fn()),
  )
  const cauda = current.then(
    () => {},
    () => {},
  )
  queues.set(key, cauda)
  void cauda.then(() => {
    if (queues.get(key) === cauda) queues.delete(key)
  })
  return current
}

/** Is there an operation queued or running on this folder? (diagnostics and test) */
export async function workspaceLockPending(directory: string): Promise<boolean> {
  return queues.has(await workspaceKey(directory))
}

/** Test only: clears queues and cache between cases. */
export function __resetWorkspaceLocks(): void {
  queues.clear()
  keyCache.clear()
  keyOrder = Promise.resolve()
}
