import type { Task } from '@shared/pipeline'

/**
 * Phase output contract and dependency rules. Deliberately pure (only type
 * imports): it is the logic that decides whether a phase was worth anything and
 * whether a task may start, and failing here silently is expensive — kept apart
 * from the engine it is covered by tests without loading Electron.
 */

/**
 * Extracts the note from the ```anotacao block. It is the only channel between
 * one phase and the next: without it the phase counts as a failure, because the
 * next one would receive noise (or the model's loose narration) instead of the
 * report.
 */
export function extractNote(text: string): string | undefined {
  const block = text.match(/```anotacao\s*\n([\s\S]*?)```/i)
  const content = block?.[1]?.trim()
  return content || undefined
}

/**
 * Commit hash mentioned in the note. Requires commit context nearby: a loose
 * `\b[0-9a-f]{7,40}\b` matches a file hash, an id and even words like "added" —
 * the wrong commit in the report is worse than none.
 */
export function extractCommit(text: string): string | undefined {
  const withContext = text.match(
    /(?:commit|hash|sha)[^0-9a-f]{0,20}\b([0-9a-f]{7,40})\b/i,
  )
  return withContext?.[1]
}

/** Dependencies not completed yet — they block the automatic start (D15). */
export function pendingDependencies(task: Task, all: Task[]): Task[] {
  return task.dependsOn
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is Task => !!t && t.status !== 'completed')
}

/**
 * Detects a cycle before saving a dependency: a task that depends (directly or
 * indirectly) on itself would jam the queue forever, with no visible error.
 */
export function createsCycle(taskId: string, newDeps: string[], all: Task[]): boolean {
  const byId = new Map(all.map((t) => [t.id, t]))
  const visit = (id: string, seen: Set<string>): boolean => {
    if (id === taskId) return true
    if (seen.has(id)) return false
    seen.add(id)
    return (byId.get(id)?.dependsOn ?? []).some((d) => visit(d, seen))
  }
  return newDeps.some((d) => visit(d, new Set()))
}
