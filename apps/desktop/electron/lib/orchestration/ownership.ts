import type { OrchestrationTask } from '@shared/chat'

/**
 * File ownership in the orchestra: each task declares the files it will touch,
 * planning keeps two parallel tasks from fighting over the same ones, and the
 * review checks whether the worker stayed inside its own. Nothing here locks —
 * these are notices for the orchestrator to decide on.
 */

/** "./src\\app/" and "src/app" are the same path for whoever compares ownership. */
export function normalizePath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
}

/**
 * Folder a path covers. A glob becomes the folder before the first wildcard
 * ("src/components/**" → "src/components"; "src/*.ts" → "src"); "" is the whole
 * project, which touches everything.
 */
function reach(filePath: string): string {
  const p = normalizePath(filePath)
  const wildcard = p.search(/[*?[{]/)
  if (wildcard < 0) return p
  const before = p.slice(0, wildcard)
  return before.includes('/') ? before.slice(0, before.lastIndexOf('/')) : ''
}

/** Same file, or one inside the other's folder. */
export function pathsTouch(a: string, b: string): boolean {
  const x = reach(a)
  const y = reach(b)
  return x === '' || y === '' || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** Does `from` wait (directly or indirectly) for `to`? */
export function waitsFor(from: OrchestrationTask, to: string, tasks: OrchestrationTask[], seen = new Set<string>()): boolean {
  for (const id of from.dependsOn ?? []) {
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    const dep = tasks.find((t) => t.id === id)
    if (dep && waitsFor(dep, to, tasks, seen)) return true
  }
  return false
}

/**
 * Tasks in the plan that would run AT THE SAME TIME as `task` touching the same
 * files. A read-only task disputes nothing, and whoever waits for the other
 * (dependsOn, even if indirect) does not run alongside.
 */
export function fileDisputes(
  task: OrchestrationTask,
  tasks: OrchestrationTask[],
): { task: OrchestrationTask; files: string[] }[] {
  if (task.options.plan || !task.files?.length) return []
  const disputes: { task: OrchestrationTask; files: string[] }[] = []
  for (const other of tasks) {
    if (other.id === task.id || other.options.plan || !other.files?.length) continue
    if (waitsFor(task, other.id, tasks) || waitsFor(other, task.id, tasks)) continue
    const common = task.files.filter((a) => other.files!.some((b) => pathsTouch(a, b)))
    if (common.length > 0) disputes.push({ task: other, files: common })
  }
  return disputes
}

/**
 * Files the worker changed outside its list. The ones belonging to another task
 * come marked with it: without a worktree the folder is shared and the worker's
 * diff may bring the neighbour's work — the reviewer needs to tell "invaded"
 * from "probably wasn't this one".
 */
export function outsideOwnership(
  task: OrchestrationTask,
  touched: string[],
  tasks: OrchestrationTask[],
): { file: string; owner?: OrchestrationTask }[] {
  if (!task.files?.length) return []
  return [...new Set(touched.map(normalizePath))]
    .filter((f) => f && !task.files!.some((a) => pathsTouch(f, a)))
    .map((file) => ({
      file,
      owner: tasks.find((t) => t.id !== task.id && t.files?.some((a) => pathsTouch(file, a))),
    }))
}
