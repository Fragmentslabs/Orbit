import type { AssistantSnapshot } from '@shared/chat'
import { git, repositoryRoot } from '../worktrees/core'

/**
 * The two diff channels the reviewer sees (orchestra/follow-up).
 *
 * With a worktree, git answers directly (worktreeDiff). Without one, the
 * evidence is the snapshots of the worker's chat turns — and a turn whose
 * capture failed leaves NO patch at all. Returning empty in that case makes the
 * reviewer read "wrote nothing" where the truth is "could not record it": that
 * is exactly what the chat-engine's end-of-turn verification exists to tell
 * apart ('unchanged' × 'unknown'). Here the failure is said out loud, and the
 * folder — the real proof, even if shared — is consulted instead of concluding
 * from the snapshot's silence.
 */

/** What matters from a turn snapshot to build the worker's diff. */
export type TurnSnapshot = Pick<AssistantSnapshot, 'patch' | 'files' | 'failed' | 'captureError' | 'verified'>

export interface TurnDiffs {
  /** Patch of the turns that WERE captured (empty when none was) */
  patch: string
  /** Notice that the channel does not have what the worker wrote; absent when every turn was recorded */
  unavailable?: string
}

/**
 * Joins the patches of the worker's turns. `failed` (the initial capture failed)
 * and `verified: 'unknown'` (the final one failed) mean the same thing here: a
 * turn whose effect on the filesystem was not recorded. `verified: 'unchanged'`
 * is the opposite — the channel worked and the turn wrote nothing — so it does
 * not become a notice.
 */
export function turnDiffs(snapshots: TurnSnapshot[]): TurnDiffs {
  const patch = snapshots
    .filter((s) => s.patch)
    .map((s) => `${(s.files ?? []).map((f) => `- ${f}`).join('\n')}\n${s.patch}`)
    .join('\n\n')

  const failures = snapshots.filter((s) => s.failed || s.verified === 'unknown')
  if (failures.length === 0 && snapshots.length > 0) return { patch }
  const reason = failures.find((s) => s.captureError)?.captureError
  return {
    patch,
    unavailable: failures.length
      ? `UNAVAILABLE: the filesystem snapshot of ${failures.length} turn(s) of this worker could not be captured${reason ? ` (${reason})` : ''}. An empty diff here does NOT mean "nothing was written" — the engine failed to record it, not the worker to do it.${patch ? ' The diff below covers only the turns that were captured.' : ' Evidence from the folder follows when there is any.'}`
      : 'UNAVAILABLE: no filesystem snapshot was recorded for this worker, so there is no diff to build from its turns.',
  }
}

/**
 * CURRENT state of the folder against HEAD: the fallback channel for when the
 * turn snapshots could not be captured.
 *
 * `git diff HEAD`, not `git diff`: the worker may have run `git add`, and the
 * plain diff would come out empty with the work on disk.
 *
 * Without a worktree the folder is SHARED — the diff may bring changes from
 * other workers and from the user themselves (the reviewer prompt already warns
 * about that).
 */
export async function folderDiff(folder: string): Promise<string> {
  const repo = await repositoryRoot(folder).catch(() => null)
  if (!repo) return ''
  const files = await git(repo, ['status', '--porcelain']).catch(() => '')
  if (!files) return ''
  const patch = await git(repo, ['diff', 'HEAD']).catch(() => '')
  return [`Folder state (shared — may include work from other workers):\n${files}`, patch]
    .filter(Boolean)
    .join('\n\n')
}
