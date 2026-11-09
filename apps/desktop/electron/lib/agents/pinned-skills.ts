import { loadSkills } from '../skills'
import { skillBody } from '../skills/mention'

/**
 * Skills fixed on an agent: their full text goes into the system prompt. The prompt is built
 * synchronously, so the bodies are read here first (`refreshPinnedSkills`, awaited when the
 * turn's profile is resolved) and the block is then read from memory.
 *
 * Only skills that exist are used; a pinned skill that was deleted is silently skipped.
 */

const bodies = new Map<string, string>()

export async function refreshPinnedSkills(slugs: readonly string[]): Promise<void> {
  if (slugs.length === 0) return
  const skills = await loadSkills()
  for (const slug of slugs) {
    const skill = skills.find((s) => s.slug === slug)
    if (skill) bodies.set(slug, skillBody(skill))
    else bodies.delete(slug)
  }
}

/** The block appended to the agent's prompt, or '' when nothing is pinned (or found). */
export function pinnedSkillsBlock(slugs: readonly string[]): string {
  const found = slugs.map((s) => bodies.get(s)).filter((b): b is string => Boolean(b))
  return found.length ? `The following skills are part of how you work. Apply them whenever they fit:\n\n${found.join('\n\n---\n\n')}` : ''
}
