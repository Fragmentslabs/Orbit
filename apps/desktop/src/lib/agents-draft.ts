import type { ProfileId } from "@shared/chat"
import type { Routine, RoutineTeam, TeamMember } from "@shared/routines"

/**
 * The "Agents" part of a routine form. One member is a single agent doing the whole job (it needs
 * no name or instruction of its own: the routine's instruction is its instruction). Two or more
 * are a team: each has a name, its own instruction and the members it waits for.
 */
export interface AgentsDraft {
  members: TeamMember[]
  /** Members working at the same time (a team only); absent = the engine's default. */
  maxParallel?: number
  /** Tokens one execution may spend (a team only); absent = no ceiling. */
  tokenBudget?: number
  /** The model reviews each agent's work (a team only; costs more); absent = no review. */
  review?: boolean
}

let counter = 0
export function newMember(over: Partial<TeamMember> = {}): TeamMember {
  return { id: `m${Date.now().toString(36)}${(counter++).toString(36)}`, name: "", task: "", ...over }
}

/** A routine starts with one agent: the general setup. */
export function emptyAgents(): AgentsDraft {
  return { members: [newMember()] }
}

export const isTeam = (draft: AgentsDraft): boolean => draft.members.length >= 2

/** The agent of a single-agent routine (`agent:<id>`), or undefined for the general setup or a team. */
export function soloAgent(draft: AgentsDraft): ProfileId | undefined {
  return isTeam(draft) ? undefined : draft.members[0]?.agent
}

/** Removes a member and every dependency on it. */
export function withoutMember(draft: AgentsDraft, id: string): AgentsDraft {
  return {
    ...draft,
    members: draft.members
      .filter((m) => m.id !== id)
      .map((m) => ({ ...m, dependsOn: m.dependsOn?.filter((d) => d !== id) })),
  }
}

/** Is the draft ready to save? A single agent always is; every member of a team needs a name and an instruction. */
export function agentsAreValid(draft: AgentsDraft): boolean {
  return !isTeam(draft) || draft.members.every((m) => m.name.trim() && m.task.trim())
}

/** The draft of a routine (or of a proposal) as it is stored. */
export function draftOf(source: Pick<Routine, "agent" | "team" | "tokenBudget" | "review">): AgentsDraft {
  const members = source.team?.members ?? []
  if (members.length >= 2) {
    return { members: members.map((m) => ({ ...m })), maxParallel: source.team?.maxParallel, tokenBudget: source.tokenBudget, review: source.review }
  }
  return { members: [newMember({ agent: source.agent ?? members[0]?.agent })] }
}

/** What goes into the routine record: `agent` for a single agent, `team` (and a budget) for a team. */
export function storedFields(draft: AgentsDraft): { agent?: ProfileId; team?: RoutineTeam; tokenBudget?: number; review?: boolean } {
  if (!isTeam(draft)) {
    const agent = soloAgent(draft)
    return agent ? { agent } : {}
  }
  return {
    team: { members: draft.members, ...(draft.maxParallel ? { maxParallel: draft.maxParallel } : {}) },
    ...(draft.tokenBudget ? { tokenBudget: draft.tokenBudget } : {}),
    ...(draft.review ? { review: true } : {}),
  }
}

/** The names a member waits for (empty = it starts right away, with the first ones). */
export function waitsFor(member: TeamMember, members: readonly TeamMember[], unnamed = "…"): string[] {
  return (member.dependsOn ?? [])
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is TeamMember => !!m)
    .map((m) => m.name.trim() || unnamed)
}
