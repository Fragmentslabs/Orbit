import type { OrchestrationPlan, OrchestrationTask } from '@shared/chat'
import type { RoutineTeam } from '@shared/routines'

/** Plan limit shared with the planner (see MAX_TASKS_TOTAL in execution.ts). */
const MAX_MEMBERS = 8

/**
 * The plan of a routine's team, built from the members instead of planned by a model: the
 * routine's author already decided who does what. Ids are fresh per run (the plan is a record of
 * that run); a dependency on a member that does not exist, or on itself, is dropped, and so is
 * any member past the limit. Returns null for an empty team.
 */
export function planFromTeam(
  team: RoutineTeam,
  newId: (prefix: string) => string,
  /** The team works in a folder of its own: members hand their results over as files too. */
  options: { handoff?: boolean } = {},
): OrchestrationPlan | null {
  const members = team.members.filter((m) => m.name.trim() && m.task.trim()).slice(0, MAX_MEMBERS)
  if (members.length === 0) return null
  const names = members.map((m) => m.name.trim())
  const taskIds = new Map(members.map((m) => [m.id, newId('task')]))
  const tasks: OrchestrationTask[] = members.map((m) => {
    const dependsOn = (m.dependsOn ?? [])
      .filter((id) => id !== m.id)
      .map((id) => taskIds.get(id))
      .filter((id): id is string => !!id)
    return {
      id: taskIds.get(m.id)!,
      title: m.name.trim(),
      prompt: options.handoff ? `${m.task.trim()}${handoffNote(m.name, names)}` : m.task.trim(),
      options: {},
      status: 'idle',
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(m.agent ? { agent: m.agent } : {}),
      ...(m.model ? { model: m.model } : {}),
    }
  })
  return { id: newId('plan'), tasks, status: 'proposed' }
}

/** "Weekly report" → "weekly-report.md": the file a member leaves its result in. */
export function handoffFileName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'result'}.md`
}

/**
 * Added to a member's task when the team works in a folder of its own. The summary that reaches
 * a dependent member is cut short; the file is the whole result, so nothing the next member
 * needs is lost to the cut.
 */
function handoffNote(name: string, allNames: string[]): string {
  const others = allNames.filter((n) => n !== name.trim()).map((n) => `${n} (${handoffFileName(n)})`)
  return [
    '\n\n## Shared working folder',
    `Your working folder is shared with the rest of the team and is where the result of this run is kept. Write your complete result there in a file named ${handoffFileName(name)}, and any other files you produce, then mention their names in your final summary.`,
    others.length > 0 ? `The others leave theirs the same way: ${others.join(', ')}. Read the files of the ones you depend on instead of relying on their summary alone.` : '',
    'You can also leave a short note for a teammate with message_teammate, but results belong in files.',
  ]
    .filter(Boolean)
    .join('\n')
}
