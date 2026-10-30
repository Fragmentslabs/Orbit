import { tool } from 'ai'
import { z } from 'zod'
import { loadSkills } from '../skills'

/**
 * Loads the full content of a skill by slug.
 *
 * The app's native skills enter the prompt with only the description (otherwise every
 * turn would pay for the whole text of a recipe that may not even be used);
 * this tool returns the body at the moment the agent is going to apply the skill.
 */
export function createSkillReadTool(directory?: string) {
  return tool({
    description:
      'Loads the full content of a skill by slug (e.g. "web_recon"). Built-in skills appear in the prompt with only their description — read one before applying it.',
    inputSchema: z.object({
      slug: z.string().describe('Skill slug, without the @ (e.g.: web_recon)'),
    }),
    execute: async ({ slug }) => {
      const wanted = slug.replace(/^@/, '').trim()
      const skills = await loadSkills(directory)
      const skill = skills.find((s) => s.slug === wanted)
      if (!skill) {
        const available = skills.map((s) => `@${s.slug}`).join(', ')
        return `Skill not found: @${wanted}. Available skills: ${available || '(none)'}`
      }
      return `# @${skill.slug} (${skill.source})\n\n${skill.content}`
    },
  })
}
