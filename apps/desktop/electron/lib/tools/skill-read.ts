import { tool } from 'ai'
import { z } from 'zod'
import { loadSkills } from '../skills'
import { recordSkillUse, usageScope } from '../skills/meta'
import { skillBody } from '../skills/mention'

export interface SkillToolContext {
  directory?: string
  /** The MAIN conversation: a worker's use counts for its parent, never for itself. */
  sessionId?: string
  mode?: 'chat' | 'code'
}

/**
 * Loads the full content of a skill by slug.
 *
 * The prompt carries only an index (the native skills with their description, the user's
 * with a one-line summary or just the name); this tool returns the body at the moment
 * the agent is going to apply the skill. Opening counts as a use, once per conversation.
 */
export function createSkillReadTool(context: SkillToolContext = {}) {
  return tool({
    description:
      'Loads the full content of a skill by slug (e.g. "web_recon"). The prompt lists skills by name or with a one-line summary only — read one before applying it.',
    inputSchema: z.object({
      slug: z.string().describe('Skill slug, without the @ (e.g.: web_recon)'),
    }),
    execute: async ({ slug }) => {
      const wanted = slug.replace(/^@/, '').trim().toLowerCase()
      const skills = await loadSkills(context.directory)
      const skill = skills.find((s) => s.slug === wanted)
      if (!skill) {
        const names = skills.slice(0, 60).map((s) => `@${s.slug}`).join(', ')
        const more = skills.length > 60 ? ', …' : ''
        return `Skill not found: @${wanted}. Available skills: ${names ? names + more : '(none)'}. Use skill_search to look one up by topic.`
      }
      if (skill.source !== 'builtin' && context.sessionId) {
        const scope = await usageScope(context.mode ?? 'chat', context.directory)
        void recordSkillUse({ slug: skill.slug, scope, sessionId: context.sessionId })
      }
      return skillBody(skill, { header: `# @${skill.slug} (${skill.source})`, withDescription: false })
    },
  })
}
