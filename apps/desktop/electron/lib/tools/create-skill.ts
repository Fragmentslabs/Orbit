import { tool } from 'ai'
import { ASK_WHEN_VAGUE } from './proposal-guidance'
import { z } from 'zod'
import { notifySkillsChanged } from '../skills'
import { SKILL_SUMMARY_LIMIT, SKILL_TAGS_MAX, SKILL_TAGS_MIN } from '@shared/skills'
import { proposeSkill } from '../skills/pending'

/**
 * create_skill tool: the agent PROPOSES a skill (with optional scripts). The
 * proposal goes to staging and appears as an "Add skill" card in the conversation —
 * it only comes into use when the user approves it in the card.
 */
export function createSkillTool(language?: string) {
  return tool({
    description:
      'Proposes a new Orbit skill: curated knowledge in markdown, optionally accompanied by helper scripts/files the skill uses. The proposal appears as an "Add skill" card in the conversation and is only activated once the user approves it. After calling, briefly explain what the skill does and how it was structured. ' + ASK_WHEN_VAGUE,
    inputSchema: z.object({
      name: z.string().describe('Display name (e.g.: API Deploy)'),
      description: z.string().describe('Short description of what the skill covers'),
      content: z
        .string()
        .describe(
          'Skill content in markdown. If there are scripts, explain here when and how to run them (relative paths).',
        ),
      summary: z
        .string()
        .describe(
          `The skill's card: ONE line of at most ${SKILL_SUMMARY_LIMIT} characters starting with a verb, saying what it is FOR. Written in the user's language; technical terms stay as people write them (deploy, XML, ffmpeg). Over the limit is refused.`,
        ),
      tags: z
        .array(z.string())
        .describe(
          `${SKILL_TAGS_MIN + 2} to ${SKILL_TAGS_MAX} words or short phrases the USER would type when asking for this — their own vocabulary, in their language, technical terms unchanged.`,
        ),
      slug: z
        .string()
        .optional()
        .describe('snake_case slug for @slug reference (e.g.: deploy_api). Derived from the name if omitted.'),
      files: z
        .array(
          z.object({
            path: z.string().describe('Relative path within the skill (e.g.: scripts/deploy.sh)'),
            content: z.string().describe('File content'),
          }),
        )
        .optional()
        .describe('Helper scripts/files that come with the skill (optional)'),
    }),
    execute: async ({ name, description, content, slug, files, summary, tags }) => {
      try {
        const proposal = await proposeSkill({ name, description, content, slug, files, summary, tags, lang: language })
        notifySkillsChanged()
        const extras = proposal.files.length
          ? ` with ${proposal.files.length} auxiliary file(s): ${proposal.files.join(', ')}`
          : ''
        return (
          `Skill @${proposal.slug} proposed${extras}. ` +
          'An "Add skill" card appeared in the conversation — the skill is only used once the user approves it. ' +
          'Now explain, in 2-4 sentences, what the skill does and how to use it.'
        )
      } catch (err) {
        return `Failed to propose the skill: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}
