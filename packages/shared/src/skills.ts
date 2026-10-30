/**
 * Skills: curated knowledge (.skill/.md files with frontmatter) injected into the
 * system prompt. Three merged sources — builtin (native to the app, read
 * only), global (orbit-data/skills) and project ({workspace}/.orbit/skills,
 * only in code mode). The precedence goes from the most specific to the least:
 * project > global > builtin (a global skill with the same slug overrides
 * the native one).
 */

export type SkillSource = "builtin" | "global" | "project"

export interface Skill {
  /** Display name (may contain spaces, capitals) */
  name: string
  description: string
  /** Snake_case slug for the @slug reference — unique, derived from the name but editable */
  slug: string
  /** Markdown body (after the frontmatter) */
  content: string
  source: SkillSource
  filePath: string
  /** Auxiliary files of the bundle (scripts/functions) — absolute paths */
  scripts?: string[]
}

/** Skill proposed by the agent (create_skill) awaiting user approval */
export interface SkillProposal {
  slug: string
  name: string
  description: string
  content: string
  /** Relative names of the auxiliary files included in the proposal */
  files: string[]
}
