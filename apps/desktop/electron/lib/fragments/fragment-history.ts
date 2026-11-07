import fsp from 'node:fs/promises'
import path from 'node:path'
import type { FragmentManifest } from '@shared/fragments'
import type { FragmentRevisionInfo, FragmentRevisionKind } from '@shared/fragment-details'
import { deleteFragmentFile, fragmentDir, readFragmentFile, writeFragmentFile } from './fragment-store'

/**
 * Per-turn history of a fragment's files — `orbit-data/fragments/<id>/.history/`.
 *
 * Every write the AGENT makes is a revision: one small file holding what the file looked
 * like BEFORE the write (null when the write created it). Undoing is then exact and cheap —
 * no copy of the whole fragment per write — and a revert is "put the files back as they were
 * before revision N", which also drops N and everything after it (the history is a line,
 * not a tree).
 *
 * The person's own changes (name, pins, grants) and the data the page saves are not code and
 * are not here. The page can never reach this folder: the scheme serves `src/` only.
 */

const KEEP_REVISIONS = 80
/** Past this much stored history, the oldest revisions go first. */
const KEEP_BYTES = 12 * 1024 * 1024

interface StoredRevision extends FragmentRevisionInfo {
  /** The file as it was before the write; null = it did not exist. */
  before: string | null
}

function historyDir(id: string): string {
  return path.join(fragmentDir(id), '.history')
}

const fileOf = (id: string, revision: number): string => path.join(historyDir(id), `${String(revision).padStart(8, '0')}.json`)

async function readAll(id: string): Promise<StoredRevision[]> {
  let names: string[]
  try {
    names = (await fsp.readdir(historyDir(id))).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  const all = await Promise.all(
    names.map(async (name) => {
      try {
        return JSON.parse(await fsp.readFile(path.join(historyDir(id), name), 'utf8')) as StoredRevision
      } catch {
        return null
      }
    }),
  )
  return all.filter((r): r is StoredRevision => !!r && typeof r.revision === 'number' && typeof r.path === 'string')
}

const sizeOf = (r: StoredRevision): number => (r.before ? Buffer.byteLength(r.before, 'utf8') : 0)

/** Oldest first, until both the count and the weight are within the limits. */
async function prune(id: string): Promise<void> {
  const all = await readAll(id)
  const overflow = Math.max(0, all.length - KEEP_REVISIONS)
  let bytes = all.reduce((sum, r) => sum + sizeOf(r), 0)
  for (let i = 0; i < all.length && (i < overflow || bytes > KEEP_BYTES); i++) {
    bytes -= sizeOf(all[i])
    await fsp.rm(fileOf(id, all[i].revision), { force: true })
  }
}

/** A turn of an agent: the id every write of that turn shares. */
export interface RevisionContext {
  turn: string
  sessionId?: string
}

/**
 * Runs an agent write and records it. `run` must perform the store write and return the new
 * manifest; the revision number is that manifest's, so history and manifest cannot disagree.
 */
export async function withRevision(
  id: string,
  context: RevisionContext,
  file: { path: string; deleting?: boolean },
  run: () => Promise<FragmentManifest>,
): Promise<FragmentManifest> {
  const before = await readFragmentFile(id, file.path)
  const manifest = await run()
  const kind: FragmentRevisionKind = file.deleting ? 'delete' : before === null ? 'create' : 'edit'
  const record: StoredRevision = {
    revision: manifest.revision,
    at: Date.now(),
    turn: context.turn,
    sessionId: context.sessionId,
    path: file.path.replace(/\\/g, '/').replace(/^\/+/, ''),
    kind,
    before,
  }
  try {
    await fsp.mkdir(historyDir(id), { recursive: true })
    await fsp.writeFile(fileOf(id, record.revision), JSON.stringify(record), 'utf8')
    await prune(id)
  } catch {
    // History is a convenience: failing to keep it must never fail the write itself.
  }
  return manifest
}

/** The history, newest first, without the stored contents. */
export async function listRevisions(id: string): Promise<FragmentRevisionInfo[]> {
  const all = await readAll(id)
  return all
    .map(({ before: _before, ...info }) => info)
    .sort((a, b) => b.revision - a.revision)
}

/** Weight of the history on disk (the details panel counts it). */
export async function historyBytes(id: string): Promise<number> {
  const all = await readAll(id)
  return all.reduce((sum, r) => sum + sizeOf(r), 0)
}

/**
 * Puts the files back as they were BEFORE `revision`: every later write is undone, newest
 * first, then forgotten. Returns the manifest after the last restore (its revision moves
 * forward, so the open page reloads), or null when the revision is not in the history.
 */
export async function revertToBefore(id: string, revision: number): Promise<FragmentManifest | null> {
  const all = (await readAll(id)).sort((a, b) => b.revision - a.revision)
  const undo = all.filter((r) => r.revision >= revision)
  if (undo.length === 0 || !undo.some((r) => r.revision === revision)) return null
  let manifest: FragmentManifest | null = null
  for (const entry of undo) {
    try {
      manifest =
        entry.before === null
          ? await deleteFragmentFile(id, entry.path)
          : await writeFragmentFile(id, entry.path, entry.before)
    } catch {
      // A file that cannot be put back (it was created and is already gone) is skipped; the rest still reverts.
    }
    await fsp.rm(fileOf(id, entry.revision), { force: true })
  }
  return manifest
}
