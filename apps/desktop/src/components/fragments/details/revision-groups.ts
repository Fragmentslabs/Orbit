import type { FragmentRevisionInfo } from "@shared/fragment-details"

/** One agent turn: its writes in order, and the revision to undo back to the start of it. */
export interface RevisionTurn {
  turn: string
  /** When the turn started writing. */
  at: number
  /** The first write of the turn: undoing to before it undoes the whole turn. */
  firstRevision: number
  changes: FragmentRevisionInfo[]
}

/** The history (newest first) grouped by agent turn, newest turn first. */
export function groupRevisionsByTurn(revisions: FragmentRevisionInfo[]): RevisionTurn[] {
  const byTurn = new Map<string, FragmentRevisionInfo[]>()
  for (const revision of revisions) byTurn.set(revision.turn, [...(byTurn.get(revision.turn) ?? []), revision])
  return [...byTurn.entries()]
    .map(([turn, list]) => {
      const changes = [...list].sort((a, b) => a.revision - b.revision)
      return { turn, at: changes[0].at, firstRevision: changes[0].revision, changes }
    })
    .sort((a, b) => b.firstRevision - a.firstRevision)
}
