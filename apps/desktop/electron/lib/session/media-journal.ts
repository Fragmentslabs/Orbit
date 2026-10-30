import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MediaEntry } from '@shared/media'
import { writeFileAtomic } from '../asset-lock'

/**
 * Media journal per TURN — what makes undoable everything the agent
 * produced outside the repository: pieces (motion, design, slides), artifacts,
 * documents, images, audio and videos in the gallery.
 *
 * The snapshot of code mode (snapshot/index.ts) photographs the whole working
 * folder at the start of the turn. Here that would be expensive (the gallery holds videos) and would not
 * exist in chat. So the recording is LAZY: the first time a
 * turn is about to touch a path or a gallery entry, it is stored as it was
 * BEFORE — a copy (an APFS clone, almost free) or "did not exist".
 * What the turn does not touch costs nothing.
 *
 * The scope is an AsyncLocalStorage opened by the chat-engine around the turn:
 * the tools, the streaming that opens the live tab and whatever they trigger inherit
 * the scope without receiving anything by parameter. What runs OUTSIDE a turn (the person
 * editing in the panel, deleting in the gallery) is not recorded — it is not the agent's.
 *
 * Each assistant message has its own journal on disk
 * (`userData/media-journal/<session>/<message>/`), written on every record:
 * a crash in the middle of the turn does not lose the previous state of what was already touched.
 */

export type PieceKind = 'motion' | 'design' | 'slides'

/** The piece that owns a registered folder — the revert re-registers it or removes it from the record. */
export interface PieceRef {
  kind: PieceKind
  id: string
  folder: string
  /** Entry inside the folder (motion/slides). */
  entry?: string
  root?: string
  sessionId?: string
}

/**
 * State of a path (file, folder or symlink) at an instant.
 *
 * The journal stores the state BEFORE (`backup`/`before`) and AFTER (`after`).
 * On revert, the current one is compared with the after: it only undoes what is still
 * as the turn left it. If another conversation (or the person, in the panel) touched it
 * afterwards, the path is preserved and becomes a conflict.
 */
export interface PathState {
  exists: boolean
  /** sha256 of the content (file), of the tree (folder) or of the target (symlink). */
  hash: string | null
  kind?: 'file' | 'dir' | 'symlink'
}

export function samePathState(a: PathState, b: PathState): boolean {
  return a.exists === b.exists && a.hash === b.hash && (a.kind ?? null) === (b.kind ?? null)
}

const ABSENT: PathState = { exists: false, hash: null }

function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Deterministic hash of a path — content, names and types, in order.
 * Folders come in recursively; symlinks come in by the TEXT of the target (without
 * following it, otherwise a broken link would bring the comparison down).
 */
export async function hashPath(target: string): Promise<PathState> {
  const st = await fsp.lstat(target).catch(() => null)
  if (!st) return ABSENT
  if (st.isSymbolicLink()) {
    const link = await fsp.readlink(target).catch(() => null)
    return link === null
      ? { exists: true, hash: null, kind: 'symlink' }
      : { exists: true, hash: sha256(`link\0${link}`), kind: 'symlink' }
  }
  if (st.isFile()) {
    return { exists: true, hash: await hashFile(target), kind: 'file' }
  }
  if (st.isDirectory()) {
    const hash = crypto.createHash('sha256')
    for (const name of (await fsp.readdir(target)).sort()) {
      hash.update(`entry\0${name}\0`)
      const child = await hashPath(path.join(target, name))
      hash.update(child.exists ? `${child.kind ?? 'other'}:${child.hash ?? ''}` : 'absent')
      hash.update('\0')
    }
    return { exists: true, hash: hash.digest('hex'), kind: 'dir' }
  }
  return { exists: true, hash: sha256('other'), kind: 'file' }
}

export type JournalRecord =
  | {
      type: 'path'
      path: string
      /** Name of the copy inside `files/` — null when the path did not exist. */
      backup: string | null
      piece?: PieceRef
      /** Gallery entry that owns this file (artifact/document). */
      owner?: string
      /** State of the path AFTER the turn; absent in old journals/crash. */
      after?: PathState
    }
  | {
      type: 'media'
      id: string
      before: MediaEntry | null
      /** The entry AFTER the turn (what the turn wrote). */
      after?: MediaEntry | null
    }

/** Record ready to apply: the copy already resolved to the absolute path. */
export type RestoreRecord =
  | {
      type: 'path'
      path: string
      backupFile: string | null
      piece?: PieceRef
      owner?: string
      after?: PathState
    }
  | { type: 'media'; id: string; before: MediaEntry | null; after?: MediaEntry | null }

interface Scope {
  sessionId: string
  messageId?: string
  closed: boolean
  keys: Set<string>
  records: JournalRecord[]
  /** Serial queue of the scope: two records of the same key never run together. */
  chain: Promise<unknown>
}

const storage = new AsyncLocalStorage<Scope>()
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,80}$/
const MANIFEST = 'journal.json'
/** Redo folder (unrevert) of a session — outside the message id pattern. */
export const REDO_DIR = '_redo'

export function journalRoot(): string {
  return path.join(app.getPath('userData'), 'media-journal')
}

export function sessionJournalDir(sessionId: string): string {
  if (!SAFE_SEGMENT.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(journalRoot(), sessionId)
}

function messageJournalDir(sessionId: string, messageId: string): string {
  if (!SAFE_SEGMENT.test(messageId)) throw new Error(`invalid message id: ${messageId}`)
  return path.join(sessionJournalDir(sessionId), messageId)
}

/** Opens the turn scope around `fn`. The message comes in later (bindMediaJournal). */
export function runWithMediaJournal<T>(sessionId: string, fn: () => T): T {
  if (!SAFE_SEGMENT.test(sessionId)) return fn()
  return storage.run({ sessionId, closed: false, keys: new Set(), records: [], chain: Promise.resolve() }, fn)
}

/**
 * Binds the scope to the assistant message of the turn. Before that nothing is
 * recorded: the journal lives in the message, and without it the revert would not find it.
 */
export function bindMediaJournal(messageId: string): void {
  const scope = storage.getStore()
  if (!scope || !SAFE_SEGMENT.test(messageId)) return
  scope.messageId = messageId
}

/**
 * Closes the scope and writes the FINAL state of each recorded path.
 *
 * `closed` is set BEFORE the asynchronous work: whatever still runs inheriting
 * the scope (the gallery cover taken in the background) is no longer the turn's and does not
 * enter the journal. The `after` is what lets the revert compare "is the worktree
 * still as the turn left it?" — without it, an old/crashed turn becomes a
 * conflict, never a blind restore.
 *
 * Never throws: the end of the turn cannot depend on the journal.
 */
export async function closeMediaJournal(): Promise<void> {
  const scope = storage.getStore()
  if (!scope) return
  scope.closed = true
  if (!scope.messageId) return
  const s = scope as Scope & { messageId: string }
  try {
    await s.chain
    for (const record of s.records) {
      if (record.type !== 'path' || record.after) continue
      try {
        record.after = await hashPath(record.path)
      } catch (err) {
        // Without a final state, the revert treats the path as a conflict.
        console.error('[media-journal] final hash failed:', record.path, err)
      }
    }
    await persistScope(s)
  } catch (err) {
    console.error('[media-journal] closing the journal failed:', err)
  }
}

function activeScope(): (Scope & { messageId: string }) | null {
  const scope = storage.getStore()
  if (!scope || scope.closed || !scope.messageId) return null
  return scope as Scope & { messageId: string }
}

export function mediaJournalActive(): boolean {
  return activeScope() !== null
}

/** `child` inside `parent` (or equal)? */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Only the app storage enters the journal. The working folder of code mode
 * has its own snapshot, and a copy of the repository here would be expensive and duplicated.
 */
function isJournaledPath(target: string): boolean {
  const userData = app.getPath('userData')
  return isInside(userData, target) && !isInside(journalRoot(), target)
}

/**
 * Copies a file or a whole folder. COPYFILE_FICLONE: on APFS it is a clone
 * (the copies share the blocks until someone writes), and on other systems it falls
 * back to a regular copy.
 */
export async function cloneInto(source: string, target: string): Promise<void> {
  const stat = await fsp.lstat(source)
  if (stat.isDirectory()) {
    await fsp.mkdir(target, { recursive: true })
    for (const name of await fsp.readdir(source)) {
      await cloneInto(path.join(source, name), path.join(target, name))
    }
    return
  }
  if (stat.isSymbolicLink()) {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.symlink(await fsp.readlink(source), target)
    return
  }
  if (!stat.isFile()) return
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.copyFile(source, target, fs.constants.COPYFILE_FICLONE)
}

async function persistScope(scope: Scope & { messageId: string }): Promise<void> {
  const dir = messageJournalDir(scope.sessionId, scope.messageId)
  await writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify({ v: 2, records: scope.records }))
}

/** Queues on the scope — and a journal failure never brings down the tool that was writing. */
function enqueue(scope: Scope & { messageId: string }, op: () => Promise<void>): Promise<void> {
  const run = scope.chain.then(op).catch((err) => {
    console.error('[media-journal] record failed:', err)
  })
  scope.chain = run
  return run
}

/**
 * Stores the state of `target` (file or folder) BEFORE its first change
 * in this turn. Call it right before writing, deleting or replacing — inside the
 * same write lock, so that nobody changes the path between the copy and it.
 */
export async function journalPath(target: string, piece?: PieceRef, owner?: string): Promise<void> {
  const scope = activeScope()
  if (!scope) return
  const resolved = path.resolve(target)
  if (!isJournaledPath(resolved)) return
  const key = `path:${resolved}`
  await enqueue(scope, async () => {
    if (scope.keys.has(key)) return
    // A folder already registered WHOLE covers whatever is inside it.
    for (const record of scope.records) {
      if (record.type === 'path' && isInside(record.path, resolved)) return
    }
    scope.keys.add(key)
    const exists = await fsp.lstat(resolved).then(() => true, () => false)
    let backup: string | null = null
    if (exists) {
      backup = `b${scope.records.length}`
      await cloneInto(resolved, path.join(messageJournalDir(scope.sessionId, scope.messageId), 'files', backup))
    }
    scope.records.push({ type: 'path', path: resolved, backup, piece, owner })
    await persistScope(scope)
  })
}

/** Equality of two gallery entries — the order of the keys does not count. */
function sameEntry(a: MediaEntry | undefined, b: MediaEntry | undefined): boolean {
  if (!a || !b) return a === b
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (JSON.stringify((a as unknown as Record<string, unknown>)[key]) !== JSON.stringify((b as unknown as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}

/**
 * Called by whoever writes the gallery index, with the index from before and the one from
 * after: every entry created, changed or removed stores the previous state —
 * entry by entry, so the revert never restores the index as a block (which
 * would delete what another chat wrote in the middle).
 */
export async function journalMediaIndex(previous: MediaEntry[], next: MediaEntry[]): Promise<void> {
  const scope = activeScope()
  if (!scope) return
  const before = new Map(previous.map((e) => [e.id, e]))
  const after = new Map(next.map((e) => [e.id, e]))
  const changed: Array<{ id: string; before: MediaEntry | null; after: MediaEntry | null }> = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (!sameEntry(before.get(id), after.get(id))) {
      changed.push({ id, before: before.get(id) ?? null, after: after.get(id) ?? null })
    }
  }
  if (changed.length === 0) return
  await enqueue(scope, async () => {
    let dirty = false
    for (const item of changed) {
      const existing = scope.records.find(
        (record): record is Extract<JournalRecord, { type: 'media' }> =>
          record.type === 'media' && record.id === item.id,
      )
      if (existing) {
        // The turn touched the same entry again: the `before` stays the one from the
        // FIRST change, and the `after` becomes the final state of the turn.
        existing.after = item.after
        dirty = true
        continue
      }
      scope.keys.add(`media:${item.id}`)
      scope.records.push({ type: 'media', id: item.id, before: item.before, after: item.after })
      dirty = true
    }
    if (dirty) await persistScope(scope)
  })
}

export interface LoadedJournal {
  dir: string
  records: JournalRecord[]
}

async function readManifest(dir: string): Promise<LoadedJournal | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8')) as { records?: JournalRecord[] }
    return Array.isArray(raw.records) ? { dir, records: raw.records } : null
  } catch {
    return null
  }
}

/** The journal of an assistant message, if the turn touched any media. */
export async function readMediaJournal(sessionId: string, messageId: string): Promise<LoadedJournal | null> {
  if (!SAFE_SEGMENT.test(messageId)) return null
  return readManifest(messageJournalDir(sessionId, messageId))
}

/** The redo stored by the last revert of the session. */
export async function readRedoJournal(sessionId: string): Promise<LoadedJournal | null> {
  return readManifest(path.join(sessionJournalDir(sessionId), REDO_DIR))
}

/**
 * Joins the journals of several turns (in chronological order) into one: the revert
 * undoes from the chosen turn to the end, and the state to restore for each path
 * or entry is the one from the FIRST turn that touched it. A folder registered whole
 * covers the paths inside it registered by later turns. Pure.
 */
export function mergeJournals(journals: LoadedJournal[]): RestoreRecord[] {
  const out: RestoreRecord[] = []
  const byKey = new Map<string, RestoreRecord>()
  const folders: string[] = []
  for (const journal of journals) {
    for (const record of journal.records) {
      if (record.type === 'media') {
        const key = `media:${record.id}`
        const existing = byKey.get(key)
        if (existing && existing.type === 'media') {
          // The `before` is the one from the FIRST turn; the `after` is the one from the LAST that touched
          // it — that is the state the worktree has now and that the revert will
          // compare.
          existing.after = record.after
          continue
        }
        const next = { ...record }
        byKey.set(key, next)
        out.push(next)
        continue
      }
      const resolved = path.resolve(record.path)
      const key = `path:${resolved}`
      const existing = byKey.get(key)
      if (existing && existing.type === 'path') {
        existing.after = record.after
        continue
      }
      if (folders.some((folder) => isInside(folder, resolved))) continue
      const next: RestoreRecord = {
        type: 'path',
        path: resolved,
        backupFile: record.backup ? path.join(journal.dir, 'files', record.backup) : null,
        piece: record.piece,
        owner: record.owner,
        after: record.after,
      }
      byKey.set(key, next)
      out.push(next)
      folders.push(resolved)
    }
  }
  return out
}

/**
 * Writes a ready journal (the redo of the revert): captures the CURRENT state of each
 * record in `dir`, which is recreated from scratch.
 */
export async function captureJournal(
  dir: string,
  records: RestoreRecord[],
  currentEntry: (id: string) => Promise<MediaEntry | null>,
): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true })
  const out: JournalRecord[] = []
  for (const record of records) {
    if (record.type === 'media') {
      out.push({ type: 'media', id: record.id, before: await currentEntry(record.id) })
      continue
    }
    const exists = await fsp.lstat(record.path).then(() => true, () => false)
    let backup: string | null = null
    if (exists) {
      backup = `b${out.length}`
      await cloneInto(record.path, path.join(dir, 'files', backup))
    }
    out.push({ type: 'path', path: record.path, backup, piece: record.piece, owner: record.owner })
  }
  await writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify({ v: 2, records: out }))
}

/**
 * Fills in the `after` of a journal already written — used in the redo of the revert, after
 * applying: the final state is what the unrevert will require to find so that it
 * can undo without deleting newer changes.
 */
export async function finalizeJournal(
  dir: string,
  currentEntry: (id: string) => Promise<MediaEntry | null>,
): Promise<void> {
  const loaded = await readManifest(dir)
  if (!loaded) return
  const records: JournalRecord[] = []
  for (const record of loaded.records) {
    if (record.type === 'media') {
      records.push({ ...record, after: await currentEntry(record.id) })
      continue
    }
    try {
      records.push({ ...record, after: await hashPath(record.path) })
    } catch (err) {
      console.error('[media-journal] redo final hash failed:', record.path, err)
      records.push(record)
    }
  }
  await writeFileAtomic(path.join(dir, MANIFEST), JSON.stringify({ v: 2, records }))
}

/**
 * Takes each path back to the state of the record: deletes what exists now and, if there
 * was something before, puts the copy back. Only inside the app storage.
 *
 * The folder comes before what is inside it: a file registered in one turn and
 * its folder in a later turn both come back — the folder to the state of the second
 * turn, and the file, on top of that, to the one of the first.
 */
export async function restorePaths(
  records: RestoreRecord[],
  /** Revalidates the path right before swapping (whoever decided read earlier). Refused, it stays as it is. */
  stillSafe?: (record: Extract<RestoreRecord, { type: 'path' }>) => Promise<boolean>,
): Promise<RestoreRecord[]> {
  const skipped: RestoreRecord[] = []
  const paths = records
    .filter((record): record is Extract<RestoreRecord, { type: 'path' }> => record.type === 'path')
    .sort((a, b) => a.path.split(path.sep).length - b.path.split(path.sep).length)
  for (const record of paths) {
    if (!isJournaledPath(record.path)) continue
    if (stillSafe && !(await stillSafe(record))) {
      skipped.push(record)
      continue
    }
    await fsp.rm(record.path, { recursive: true, force: true })
    if (record.backupFile) await cloneInto(record.backupFile, record.path)
  }
  return skipped
}

/** Deletes journals: the ones of the given messages, or (with no list) all of the session. */
export async function deleteMediaJournals(sessionId: string, messageIds?: string[]): Promise<void> {
  if (!SAFE_SEGMENT.test(sessionId)) return
  if (!messageIds) {
    await fsp.rm(sessionJournalDir(sessionId), { recursive: true, force: true })
    return
  }
  for (const id of messageIds) {
    if (SAFE_SEGMENT.test(id)) await fsp.rm(messageJournalDir(sessionId, id), { recursive: true, force: true })
  }
}

export async function deleteRedoJournal(sessionId: string): Promise<void> {
  if (!SAFE_SEGMENT.test(sessionId)) return
  await fsp.rm(path.join(sessionJournalDir(sessionId), REDO_DIR), { recursive: true, force: true })
}

/**
 * Startup cleanup: journals older than `maxAgeMs` go away, and the ones of
 * conversations that no longer exist go away entirely. Undoing a turn from months
 * ago is not the use case, and the journal holds copies.
 */
export async function pruneMediaJournals(
  maxAgeMs: number,
  sessionExists: (sessionId: string) => Promise<boolean>,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  const sessions = await fsp.readdir(journalRoot()).catch(() => [] as string[])
  for (const session of sessions) {
    const sessionDir = path.join(journalRoot(), session)
    if (!(await sessionExists(session).catch(() => true))) {
      await fsp.rm(sessionDir, { recursive: true, force: true })
      removed += 1
      continue
    }
    const messages = await fsp.readdir(sessionDir).catch(() => [] as string[])
    for (const message of messages) {
      const dir = path.join(sessionDir, message)
      const stat = await fsp.stat(dir).catch(() => null)
      if (stat && stat.mtimeMs < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true })
        removed += 1
      }
    }
    if ((await fsp.readdir(sessionDir).catch(() => ['x'])).length === 0) {
      await fsp.rm(sessionDir, { recursive: true, force: true })
    }
  }
  return removed
}
