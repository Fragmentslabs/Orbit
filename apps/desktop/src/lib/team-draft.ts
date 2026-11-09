import type { RoutineTeam } from "@shared/routines"

/** What the editor edits: the team and the ceiling of tokens the team may spend per execution. */
export interface TeamDraft {
  team: RoutineTeam
  tokenBudget?: number
  /** The model reviews each member's work (costs more); absent = the routine runs without review. */
  review?: boolean
}

export const EMPTY_TEAM: TeamDraft = { team: { members: [] } }

/** Members whose `dependsOn` points at nobody left are cleaned when one is removed. */
export function withoutMember(team: RoutineTeam, id: string): RoutineTeam {
  return {
    ...team,
    members: team.members
      .filter((m) => m.id !== id)
      .map((m) => ({ ...m, dependsOn: m.dependsOn?.filter((d) => d !== id) })),
  }
}

/** Is the draft ready to save? Every member needs a name and an instruction. */
export function teamIsValid(draft: TeamDraft): boolean {
  return draft.team.members.every((m) => m.name.trim() && m.task.trim())
}
