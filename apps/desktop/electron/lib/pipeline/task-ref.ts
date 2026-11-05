import type { Pipeline, Task } from '@shared/pipeline'
import { taskRound } from '@shared/pipeline'

/**
 * How the chat refers to pipeline tasks. The person says "#12" (a number per
 * pipeline); the engine knows ids. Pure functions, so the tools stay thin and
 * this is testable without a data folder.
 */

/** "#12", "12" or "task 12" → 12; anything else (an id) → undefined. */
export function parseTaskNumber(ref: string): number | undefined {
  const match = /^(?:task\s*)?#?(\d{1,6})$/i.exec(ref.trim())
  return match ? Number(match[1]) : undefined
}

export type Resolved =
  | { ok: true; pipeline: Pipeline; task: Task }
  | { ok: false; message: string }

/**
 * Finds a task by number or id.
 *
 * Numbers are per pipeline, so "#3" alone can match several boards: with no
 * pipeline hint and more than one match it returns the candidates for the model
 * to ask — it never picks one.
 */
export function resolveTask(
  ref: string,
  pipelines: Array<{ pipeline: Pipeline; tasks: Task[] }>,
  hint?: { pipelineId?: string; pipeline?: string },
): Resolved {
  let scope = pipelines
  if (hint?.pipelineId) {
    scope = pipelines.filter((p) => p.pipeline.id === hint.pipelineId)
    if (scope.length === 0) return { ok: false, message: `Pipeline "${hint.pipelineId}" not found.` }
  } else if (hint?.pipeline?.trim()) {
    const term = hint.pipeline.trim().toLowerCase()
    scope = pipelines.filter((p) => p.pipeline.name.toLowerCase().includes(term))
    if (scope.length === 0) return { ok: false, message: `No pipeline matches "${hint.pipeline}".` }
  }

  const number = parseTaskNumber(ref)
  const matches: Array<{ pipeline: Pipeline; task: Task }> = []
  for (const { pipeline, tasks } of scope) {
    for (const task of tasks) {
      if (number !== undefined ? task.number === number : task.id === ref.trim()) matches.push({ pipeline, task })
    }
  }
  if (matches.length === 1) return { ok: true, ...matches[0] }
  if (matches.length === 0) return { ok: false, message: `No task found for "${ref}".` }
  return {
    ok: false,
    message:
      `Task ${ref} exists in more than one pipeline. Ask the user which one (question tool) and call again with pipelineId:\n` +
      matches.map((m) => `- ${m.pipeline.name} — pipelineId: ${m.pipeline.id} — "${m.task.title}"`).join('\n'),
  }
}

/** "#12" for a numbered task, the id for legacy data that has not been numbered yet. */
export function taskLabel(task: Pick<Task, 'id' | 'number'>): string {
  return task.number !== undefined ? `#${task.number}` : task.id
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text)

/** Header + the figures that answer "what happened with this task". */
export function summarizeTask(pipeline: Pipeline, task: Task, all: Task[]): string {
  const phase = task.currentPhase != null ? (pipeline.phases[task.currentPhase]?.name ?? `phase ${task.currentPhase}`) : '—'
  const deps = task.dependsOn
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is Task => !!t)
    .map((t) => `${taskLabel(t)} ${t.title}`)
  const lines = [
    `${taskLabel(task)} — ${task.title}`,
    `Pipeline: ${pipeline.name} · status: ${task.status} · phase: ${phase} · round ${taskRound(task)}`,
    task.error ? `Error: ${clip(task.error, 600)}` : '',
    deps.length ? `Depends on: ${deps.join('; ')}` : '',
    `Cost: ${task.cost.toFixed(4)} · tokens: ${task.tokens}`,
    task.worktree ? `Branch: ${task.worktree.branch} (worktree ${task.worktree.folder})` : '',
    task.integration ? `Integration: ${task.integration.state}${task.integration.detail ? ` — ${clip(task.integration.detail, 300)}` : ''}` : '',
    task.deliveryId ? 'Delivered: archived in the history (read-only).' : '',
    task.finalCommitHash ? `Final commit: ${task.finalCommitHash}` : '',
    task.previousCommits?.length ? `Earlier rounds' commits: ${task.previousCommits.join(', ')}` : '',
    task.diff?.files.length
      ? `Files changed (${task.diff.files.length}): ${task.diff.files.slice(0, 30).join(', ')}${task.diff.files.length > 30 ? ', …' : ''}`
      : '',
    task.returns?.length ? `Returned ${task.returns.length} time(s) for review.` : '',
    '',
    '## Description',
    clip(task.description.trim() || '(empty)', 3000),
  ]
  if (task.notes.length > 0) {
    lines.push('', '## Phase notes (use section "notes" for the full text)')
    for (const note of task.notes) {
      lines.push(`- r${note.round ?? 1} · ${note.phaseName} [${note.status}]: ${clip(note.content.replace(/\s+/g, ' '), 300)}`)
    }
  }
  return lines.filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n')
}

/** Notes in full, optionally of one phase; each capped so a long run cannot flood the chat. */
export function taskNotes(task: Task, phase?: string, perNote = 6000): string {
  const wanted = phase?.trim().toLowerCase()
  const notes = task.notes.filter((n) => !wanted || n.phaseName.toLowerCase().includes(wanted))
  if (notes.length === 0) return wanted ? `No note for a phase matching "${phase}".` : 'This task has no notes yet.'
  return notes
    .map((n) => `### ${n.phaseName} (round ${n.round ?? 1}, ${n.status})\n${clip(n.content, perNote)}`)
    .join('\n\n')
}

/** The patch of ONE file out of the task's accumulated diff (or the list of files). */
export function taskDiff(task: Task, file?: string, max = 20_000): string {
  return formatDiff(task.diff, file, max)
}

/** Same, for a diff that came from elsewhere (an archived task reads it from git). */
export function formatDiff(diff: { files: string[]; patch: string } | null | undefined, file?: string, max = 20_000): string {
  if (!diff || diff.files.length === 0) return 'This task has no recorded diff.'
  if (!file) return `Files changed (${diff.files.length}):\n${diff.files.join('\n')}\n\nAsk again with "file" to read one patch.`
  const target = file.trim()
  const chunks = diff.patch.split(/^(?=diff --git )/m)
  const found = chunks.filter((c) => {
    const header = c.split('\n', 1)[0] ?? ''
    return header.endsWith(` b/${target}`) || header.includes(target)
  })
  if (found.length === 0) return `No patch for "${file}". Files: ${diff.files.slice(0, 40).join(', ')}`
  return clip(found.join('\n'), max)
}

/** Tasks that may have their text edited: nothing is running on a prompt that was already built. */
export function isEditable(task: Pick<Task, 'status'>): boolean {
  return task.status === 'pending' || task.status === 'paused'
}
