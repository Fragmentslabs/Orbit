import { tool } from 'ai'
import { z } from 'zod'
import { loadSkills } from '../skills'

/**
 * Carrega o conteúdo completo de uma skill pelo slug.
 *
 * As skills nativas do app entram no prompt só com a descrição (senão todo
 * turno pagaria o texto inteiro de uma receita que talvez nem seja usada);
 * esta tool devolve o corpo na hora em que o agente vai aplicar a skill.
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
