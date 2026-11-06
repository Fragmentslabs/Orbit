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
  /** Card the agent wrote with the proposal (becomes the skill's card on approval) */
  summary?: string
  tags?: string[]
}

/** The summary limit is an authoring contract: the optimizer and create_skill stay inside it. */
export const SKILL_SUMMARY_LIMIT = 120
export const SKILL_TAGS_MIN = 3
export const SKILL_TAGS_MAX = 10

/**
 * Card of a skill: what the prompt index and the search read instead of the body.
 * Lives in orbit-data/skill-meta.json keyed by file path — never inside the skill file.
 */
export interface SkillCard {
  summary: string
  tags: string[]
  /** Hash of slug | name | description | content | scripts at the moment it was written */
  hash: string
  at: string
  modelId: string
  /** Language the card was written in (the user's, mirrored — not translated) */
  lang: string
}

/** none = no card · valid = card matches the file · stale = the file changed since */
export type SkillCardState = "none" | "valid" | "stale"

export interface SkillPrefs {
  /** Timestamp of the pin ("always list"); the oldest pin ranks first */
  pin?: number
  /** Never listed in the index nor suggested — only reachable by @slug */
  never?: boolean
}

/** What the panel shows for one skill. */
export interface SkillMetaView {
  slug: string
  state: SkillCardState
  card?: SkillCard
  prefs: SkillPrefs
  /** Distinct conversations that used it (scope: open repository, else global) */
  conversations: number
  lastUsedAt: number | null
  /** The numbers above come from every project, because this one has no history yet */
  scopeGlobal?: boolean
}


/** What the model proposes when asked to write a skill from a description. Nothing is saved from it. */
export interface SkillSuggestion {
  name: string
  slug: string
  description: string
  content: string
}

export type SkillGenerationResult =
  | { ok: true; suggestion: SkillSuggestion }
  | { ok: false; error: string }
