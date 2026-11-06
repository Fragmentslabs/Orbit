import type { SkillGenerationResult, SkillSuggestion } from '@shared/skills'
import type { RoutineModel } from '@shared/routines'
import { askModelForJson, contextLines } from '../headless-json'

/**
 * Writing a skill from a description, the way a routine is written: the user says
 * what the skill should teach and the model drafts name, slug, description and the
 * markdown body. Headless (no chat, no tools); nothing is saved here — the skill
 * dialog opens filled in and the user reviews and saves it.
 */

const SYSTEM = `You write skills for Orbit, an AI coding agent. A skill is a markdown document of instructions that the agent loads on demand when a task matches it, so it must be written TO THE AGENT, as clear procedures.

From the user's description, produce ONE skill.

Rules:
- "name": a short display name (2 to 5 words), in the user's language.
- "slug": snake_case, only a-z, 0-9 and underscore, at most 40 characters. It is how the skill is referenced (@slug).
- "description": ONE sentence saying WHEN to use the skill — it is what lets the agent decide to load it. Same language as the user's description.
- "content": the markdown body, without frontmatter and without a top-level title. Short sections with imperative steps, concrete checks and, when useful, a small example. Cover what the user asked for and nothing invented: do not claim tools, files or commands that the description did not mention.
- Keep it focused: a good skill is 150 to 500 words. Prefer a checklist over prose.
- Never include secrets, keys or personal data.

Answer with JSON ONLY — no prose, no markdown fences:
{"name":"...","slug":"...","description":"...","content":"..."}`

/** Same rule the skill dialog applies to a slug. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

/** The model's JSON as a skill, or null when it cannot be one. */
export function suggestionFrom(raw: Record<string, unknown>): SkillSuggestion | null {
  const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const content = str(raw.content)
  const name = str(raw.name)
  if (!content || !name) return null
  const slug = slugify(str(raw.slug)) || slugify(name)
  if (!slug) return null
  return { name, slug, description: str(raw.description), content }
}

export async function generateSkill(
  description: string,
  model: RoutineModel,
  folders: string[],
  language?: string,
): Promise<SkillGenerationResult> {
  const text = description.trim()
  if (!text) return { ok: false, error: 'Describe the skill before generating.' }

  const answer = await askModelForJson(
    SYSTEM,
    `${contextLines(folders, language)}\n\n## Skill described by the user\n${text}`,
    model,
  )
  if (!answer.ok) return answer
  const suggestion = suggestionFrom(answer.raw)
  if (!suggestion) return { ok: false, error: 'The model answered without a usable skill. Try again or switch models.' }
  return { ok: true, suggestion }
}
