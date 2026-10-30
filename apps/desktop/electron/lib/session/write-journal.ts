import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

/**
 * WRITE journal of the agent's tools in the working folder.
 *
 * The code-mode snapshot (snapshot/index.ts) says WHAT changed in the folder between
 * the start and the end of the turn, but not WHO changed it: another conversation in the same
 * folder, an external editor, a formatter or an `npm run dev` all fall into the same
 * diff. Attributing by time window forced serializing the turns of the whole
 * folder (and even then it did not cover what runs outside Orbit).
 *
 * Here every tool that writes to the folder (write, edit, image, pdf, docx…)
 * records the path BEFORE writing, through the `resolveWritePath` of the tools. The
 * revert uses that as proof of authorship: what is in the diff and was written
 * by the turn's tools is undone; what is in the diff and was NOT (bash,
 * MCP, something from outside) shows up apart, "uncertain author", and is only undone if the
 * person asks for it.
 *
 * The scope is an AsyncLocalStorage opened around the turn — the tools inherit it
 * without receiving anything as a parameter, as in the media journal. A turn that
 * is NESTED and awaited by the parent (orchestra worker) opens a child scope:
 * what it records counts for it and for the parent. Whatever is fired in parallel
 * and outlives the turn (subchat) leaves the scope with `detachFromTurn` — it is
 * another conversation.
 *
 * Recording the INTENTION (before writing) is enough: if the write fails, the
 * path does not change and does not even enter the diff.
 */

interface TurnScope {
  id: string
  startedAt: number
  /** Absolute paths (file or whole folder) written by the tools. */
  paths: Set<string>
  parent?: TurnScope
}

interface RecentWrite {
  path: string
  at: number
  /** Ids of the scope that wrote and of all the ancestors. */
  owners: Set<string>
}

const storage = new AsyncLocalStorage<TurnScope>()
/** Recent writes of ALL turns — to know what belongs to another conversation. */
const recent: RecentWrite[] = []
/** A long agent turn fits comfortably; the rest is just memory without use. */
const RECENT_TTL_MS = 6 * 60 * 60 * 1000
const RECENT_MAX = 20_000
let counter = 0

/** Opens the turn's write scope around `fn` (child of the current one, if any). */
export function runWithWriteScope<T>(fn: () => T): T {
  const parent = storage.getStore()
  const scope: TurnScope = {
    id: `w${Date.now().toString(36)}-${(counter++).toString(36)}`,
    startedAt: Date.now(),
    paths: new Set(),
    parent,
  }
  return storage.run(scope, fn)
}

/** Runs `fn` outside the current turn's scope — for another conversation fired without `await`. */
export function detachFromTurn<T>(fn: () => T): T {
  return storage.exit(fn)
}

function prune(now: number): void {
  const cutoff = now - RECENT_TTL_MS
  let drop = 0
  while (drop < recent.length && recent[drop].at < cutoff) drop += 1
  if (recent.length - drop > RECENT_MAX) drop = recent.length - RECENT_MAX
  if (drop > 0) recent.splice(0, drop)
}

/**
 * The tool is going to write (or delete/replace) `absPath` — a file or a whole
 * folder. Outside a turn it does nothing.
 */
export function recordToolWrite(absPath: string): void {
  const scope = storage.getStore()
  if (!scope) return
  const resolved = path.resolve(absPath)
  const owners = new Set<string>()
  for (let s: TurnScope | undefined = scope; s; s = s.parent) {
    s.paths.add(resolved)
    owners.add(s.id)
  }
  const now = Date.now()
  recent.push({ path: resolved, at: now, owners })
  prune(now)
}

/** Relative to `directory`, with '/', or null if it is outside it. */
function relativeTo(directory: string, abs: string): string | null {
  const rel = path.relative(path.resolve(directory), abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

export interface TurnWrites {
  /** Paths (relative, '/') written by the tools of this turn. A folder covers what is inside. */
  authored: string[]
  /** Paths written by the tools of OTHER Orbit turns during this one. */
  others: string[]
}

/**
 * What the tools wrote in `directory` during the current turn, and what those of
 * other turns wrote in the same interval. Call it at the end of the turn, inside
 * its scope; outside a scope it returns null.
 */
export function currentTurnWrites(directory: string): TurnWrites | null {
  const scope = storage.getStore()
  if (!scope) return null
  const authored = new Set<string>()
  for (const abs of scope.paths) {
    const rel = relativeTo(directory, abs)
    if (rel) authored.add(rel)
  }
  const others = new Set<string>()
  for (const write of recent) {
    if (write.at < scope.startedAt || write.owners.has(scope.id)) continue
    const rel = relativeTo(directory, write.path)
    if (rel && !authored.has(rel)) others.add(rel)
  }
  return { authored: [...authored].sort(), others: [...others].sort() }
}

/** Is `rel` one of the paths in the list, or inside a folder in the list? */
export function coveredBy(rel: string, list: Iterable<string>): boolean {
  for (const entry of list) {
    if (rel === entry || rel.startsWith(`${entry}/`)) return true
  }
  return false
}

/** For testing only. */
export function __resetWriteJournal(): void {
  recent.length = 0
}
