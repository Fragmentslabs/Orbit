import path from 'node:path'

/**
 * Registry of what the USER saved by hand through the files panel.
 *
 * The turn's snapshot diffs the WHOLE folder (`capture`/`diff` in
 * [snapshot/index.ts]), so a Ctrl+S during a turn entered the diff and the
 * engine counted that file as the agent's writing: the
 * `[Verified record: ...]` started claiming that the model changed something it
 * never touched, and that line existed precisely not to lie.
 *
 * Here stay the paths saved by the person; `verifyTurn` subtracts them before
 * assembling the turn's verdict.
 */

/**
 * Absolute path (normalized by `path.resolve`) → instant of the last
 * save. By instant, and not "clear at the start of the turn": two turns may
 * run at the same time in the same folder, and the start of one would erase the saves the
 * person made during the other.
 */
const saved = new Map<string, number>()
/** Nobody queries saves older than the longest turn. */
const SAVE_TTL_MS = 24 * 60 * 60 * 1000

export function recordManualSave(absPath: string, at = Date.now()): void {
  saved.set(path.resolve(absPath), at)
  const cutoff = at - SAVE_TTL_MS
  for (const [file, time] of saved) if (time < cutoff) saved.delete(file)
}

/**
 * The paths saved by hand inside this directory since `since` (the start of the
 * turn), relative to it and with the '/' separator — the same format in which
 * `git diff --name-only` returns them. What was saved BEFORE the turn is already in the
 * `start` and never shows up in the diff; counting it would create the inverse error — the agent
 * edits that file now and its change is subtracted from the record.
 */
export function manualSavesUnder(directory: string, since = 0): Set<string> {
  const root = path.resolve(directory)
  const result = new Set<string>()
  for (const [abs, at] of saved) {
    if (at < since) continue
    const rel = path.relative(root, abs)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      result.add(rel.replace(/\\/g, '/'))
    }
  }
  return result
}

/** For testing only: zeroes everything between cases. */
export function resetManualSaves(): void {
  saved.clear()
}

/**
 * Removes the sections of the given files from the unified diff.
 *
 * `snapshot.patch` is not just bookkeeping: it feeds the Diff tab and the list of
 * files in the message card ([code-message.tsx]). Filtering only
 * `snapshot.files` would make the user's file vanish from the verified record
 * and keep showing up on screen as the agent's work.
 *
 * It cuts at the `diff --git` boundaries, which is how git always separates the
 * files — no content line starts like that, because in the body of a
 * diff every line is prefixed by space, '+', '-' or '\'.
 */
export function stripFilesFromPatch(patch: string, exclude: Set<string>): string {
  if (!patch || exclude.size === 0) return patch
  const sections = patch.split(/^(?=diff --git )/m)
  const kept = sections.filter((section) => {
    const header = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(section)
    if (!header) return true
    return !exclude.has(header[1]) && !exclude.has(header[2])
  })
  return kept.join('')
}
