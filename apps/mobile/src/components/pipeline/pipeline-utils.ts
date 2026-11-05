import type { PhaseChoice, PhaseTemplate, Task } from '@orbit/shared'
import { isTaskSatisfied } from '@orbit/shared'
import type { TFunction } from 'i18next'

/**
 * Template name/description: the built-in phases have translated labels
 * (the prompt stays in English, like the app's other prompts); the user's own
 * phases use whatever the user wrote.
 *
 * The label family comes from `kind`, not from `i18nKey`: the i18nKey is the
 * persisted template id (Portuguese, kept for old stored templates), while the
 * kind is the English enum the translation files are keyed by.
 */
export function templateLabel(tpl: PhaseTemplate, t: TFunction): { name: string; description: string } {
  return tpl.i18nKey && !tpl.custom
    ? {
        name: t(`pipeline.phase.${tpl.kind}.name`),
        description: t(`pipeline.phase.${tpl.kind}.description`),
      }
    : { name: tpl.name, description: tpl.description }
}

/** Converts a template into a PhaseChoice (a copy, D4). */
export function fromTemplate(tpl: PhaseTemplate, t: TFunction): PhaseChoice {
  return {
    templateId: tpl.id,
    ...templateLabel(tpl, t),
    prompt: tpl.prompt,
    tools: [...tpl.tools],
    kind: tpl.kind,
  }
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * Board drag rule (mobile, restricted D8):
 * - pending → any phase (start at phase X);
 * - in_progress → only phases AHEAD of the current one (never goes back);
 * - paused → resume at the same phase or jump forward;
 * - completed → does not drag.
 */
export function validPhasesForDrop(task: Task, totalPhases: number): number[] {
  if (task.status === 'completed' || totalPhases <= 0) return []
  if (task.status === 'pending' || task.currentPhase == null) return range(totalPhases)
  if (task.status === 'in_progress') return range(totalPhases).filter((i) => i > task.currentPhase!)
  return range(totalPhases).filter((i) => i >= task.currentPhase!)
}

/**
 * Title of the dependency blocking the task (same rule as the desktop):
 * the first dependency that is not completed yet.
 */
export function blockingDependency(task: Task, tasks: Task[]): string | undefined {
  for (const id of task.dependsOn) {
    const dep = tasks.find((t) => t.id === id)
    if (dep && !isTaskSatisfied(dep)) return dep.title
  }
  return undefined
}

/**
 * "Next in the queue": the first pending task with no pending dependencies
 * (FIFO by creation — same rule as the engine). Only meaningful with the queue on.
 */
export function nextInQueue(task: Task, tasks: Task[]): boolean {
  const candidates = tasks
    .filter((t) => t.status === 'pending' && t.dependsOn.every((id) => tasks.some((x) => x.id === id && isTaskSatisfied(x))))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return candidates[0]?.id === task.id
}
