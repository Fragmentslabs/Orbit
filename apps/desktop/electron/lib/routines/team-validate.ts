import type { ProfileId } from '@shared/chat'
import type { RoutineTeam } from '@shared/routines'

/** A team member as the model writes it: dependencies by NAME, because ids do not exist yet. */
export interface RawMember {
  name: string
  task: string
  agent?: string
  dependsOn?: string[]
}

const MAX_MEMBERS = 8

/**
 * Turns the team an agent proposed into a RoutineTeam: ids are assigned, dependencies by name become
 * ids, and anything that would make the run impossible is refused with a sentence the model can act
 * on (an unknown agent, a dependency on nobody, a cycle). `agentProfiles` are the ids the person has.
 */
export function buildTeam(
  raw: readonly RawMember[],
  agentProfiles: ReadonlySet<string>,
  newId: () => string,
): { ok: true; team: RoutineTeam } | { ok: false; error: string } {
  if (raw.length < 2) return { ok: false, error: 'A team has at least two agents. For one agent, leave the team out.' }
  if (raw.length > MAX_MEMBERS) return { ok: false, error: `A team has at most ${MAX_MEMBERS} agents.` }
  const names = raw.map((m) => m.name.trim())
  if (names.some((n) => !n) || new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    return { ok: false, error: 'Every agent of the team needs its own name.' }
  }
  const ids = new Map(names.map((n) => [n.toLowerCase(), newId()]))
  const members = raw.map((m, i) => {
    const dependsOn: string[] = []
    for (const dep of m.dependsOn ?? []) {
      const id = ids.get(dep.trim().toLowerCase())
      if (!id) return `"${names[i]}" waits for "${dep}", who is not in the team.`
      if (id !== ids.get(names[i].toLowerCase())) dependsOn.push(id)
    }
    if (!m.task.trim()) return `"${names[i]}" needs an instruction.`
    if (m.agent && !agentProfiles.has(m.agent)) return `"${names[i]}" uses ${m.agent}, which is not one of the person's agents.`
    return {
      id: ids.get(names[i].toLowerCase())!,
      name: names[i],
      task: m.task.trim(),
      ...(m.agent ? { agent: m.agent as ProfileId } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    }
  })
  const problem = members.find((m): m is string => typeof m === 'string')
  if (problem) return { ok: false, error: problem }
  const built = members as RoutineTeam['members']
  if (hasCycle(built)) return { ok: false, error: 'The agents wait for each other in a circle: break the loop.' }
  return { ok: true, team: { members: built } }
}

function hasCycle(members: RoutineTeam['members']): boolean {
  const state = new Map<string, 1 | 2>()
  const byId = new Map(members.map((m) => [m.id, m]))
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    for (const dep of byId.get(id)?.dependsOn ?? []) if (visit(dep)) return true
    state.set(id, 2)
    return false
  }
  return members.some((m) => visit(m.id))
}
