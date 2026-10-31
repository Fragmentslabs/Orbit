import { tool } from 'ai'
import { z } from 'zod'
import { loadSkills } from '../skills'
import { getPrefs } from '../skills/meta'
import { searchSkills, skillSearchLine } from '../skills/retrieval'
import { entriesOf, searchSemantic } from '../skills/turn'

/**
 * Searches the user's skills by topic — the door to a name listed WITHOUT a description
 * in the prompt. Looser than the spontaneous hint (an explicit search can afford a
 * wider net), same lexical + semantic mold; the semantic side only when the embedding
 * worker is already up.
 */
export function createSkillSearchTool(context: { directory?: string } = {}) {
  return tool({
    description:
      'Searches the user\'s skills by topic and returns "@slug — summary [tags]" lines. Use it when the skill you need is only listed by name, or not listed. Then call skill_read with the @slug.',
    inputSchema: z.object({
      query: z.string().describe('What you need the skill for, in the user\'s words'),
    }),
    execute: async ({ query }) => {
      const prefs = getPrefs()
      const skills = await loadSkills(context.directory)
      const entries = entriesOf(skills).filter((e) => !prefs[e.skill.slug]?.never)
      if (entries.length === 0) return 'The user has no skills of their own.'
      const hits = await searchSkills({
        query,
        entries,
        mode: 'loose',
        semantic: await searchSemantic(query),
        max: 8,
      })
      if (hits.length === 0) return `No skill matches "${query}".`
      return hits.map((h) => skillSearchLine(h.entry)).join('\n')
    },
  })
}
