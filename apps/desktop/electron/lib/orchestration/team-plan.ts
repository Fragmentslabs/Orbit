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
export function planFromTeam(team: RoutineTeam, newId: (prefix: string) => string): OrchestrationPlan | null {
  const members = team.members.filter((m) => m.name.trim() && m.task.trim()).slice(0, MAX_MEMBERS)
  if (members.length === 0) return null
  const taskIds = new Map(members.map((m) => [m.id, newId('task')]))
  const tasks: OrchestrationTask[] = members.map((m) => {
    const dependsOn = (m.dependsOn ?? [])
      .filter((id) => id !== m.id)
      .map((id) => taskIds.get(id))
      .filter((id): id is string => !!id)
    return {
      id: taskIds.get(m.id)!,
      title: m.name.trim(),
      prompt: m.task.trim(),
      options: {},
      status: 'idle',
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(m.agent ? { agent: m.agent } : {}),
    }
  })
  return { id: newId('plan'), tasks, status: 'proposed' }
}
