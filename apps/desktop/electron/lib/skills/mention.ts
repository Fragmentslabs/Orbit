import type { Skill } from '@shared/skills'

/**
 * Pure parts of the turn's skill blocks: `@slug` detection, the body block and the
 * "skills changed" note. No disk, no Electron.
 */

/**
 * Slugs cited in the text with `@`, with a BOUNDARY: `@deploy` does not match inside
 * `@deploy_api` (slugs are `[a-z0-9_]`), an e-mail like `me@deploy.com` is not a citation,
 * and `@deploy-api` (a hyphen is not a slug character) cites nothing at all instead of
 * silently loading `@deploy`. Order of appearance, no repeats.
 */
export function mentionedSlugs(text: string, slugs: readonly string[]): string[] {
  const known = new Set(slugs)
  const found: string[] = []
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_@.])@([a-z0-9_]+)(?![a-z0-9_-])/giu)) {
    const slug = match[1].toLowerCase()
    if (known.has(slug) && !found.includes(slug)) found.push(slug)
  }
  return found
}

export function loadSkillBySlug(skills: readonly Skill[], slug: string): Skill | undefined {
  return skills.find((s) => s.slug === slug)
}

/** The body, with the helper files a bundle brings. */
export function skillBody(skill: Skill, options: { header?: string; withDescription?: boolean } = {}): string {
  const description = skill.description && options.withDescription !== false ? `\n${skill.description}` : ''
  const scripts = skill.scripts?.length
    ? `\n\nHelper files for this skill (run with bash when it says to):\n${skill.scripts.map((s) => `- ${s}`).join('\n')}`
    : ''
  const header = options.header ?? `# @${skill.slug} (${skill.source})`
  return `${header}${description}\n\n${skill.content}${scripts}`
}

/** slug → content fingerprint, to tell what changed after the prompt was built. */
export type SkillSnapshot = Record<string, string>

export function snapshotOf(skills: readonly Skill[], fingerprint: (skill: Skill) => string): SkillSnapshot {
  return Object.fromEntries(skills.map((s) => [s.slug, fingerprint(s)]))
}

export interface SkillDelta {
  added: string[]
  removed: string[]
  changed: string[]
}

export function diffSnapshots(before: SkillSnapshot, now: SkillSnapshot): SkillDelta {
  const added = Object.keys(now).filter((slug) => !(slug in before)).sort()
  const removed = Object.keys(before).filter((slug) => !(slug in now)).sort()
  const changed = Object.keys(now).filter((slug) => slug in before && before[slug] !== now[slug]).sort()
  return { added, removed, changed }
}

/**
 * The note for the turn when the set of skills changed after the (frozen) prompt was
 * built. The prompt is never recomputed mid-conversation — the provider's prefix cache
 * depends on those bytes — so the difference travels here instead.
 */
export function renderSkillDelta(delta: SkillDelta): string {
  if (delta.added.length + delta.removed.length + delta.changed.length === 0) return ''
  const at = (slugs: string[]) => slugs.map((s) => `@${s}`).join(', ')
  const lines = ['[skills changed after this prompt was built]']
  if (delta.added.length) lines.push(`now available (call skill_read to apply): ${at(delta.added)}`)
  if (delta.removed.length) lines.push(`no longer available: ${at(delta.removed)}`)
  if (delta.changed.length) lines.push(`edited since — re-read with skill_read before applying: ${at(delta.changed)}`)
  return lines.join('\n')
}
