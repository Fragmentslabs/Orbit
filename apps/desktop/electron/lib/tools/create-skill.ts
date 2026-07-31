import { tool } from 'ai'
import { z } from 'zod'
import { notifySkillsChanged } from '../skills'
import { proposeSkill } from '../skills/pending'

/**
 * Tool create_skill: o agente PROPÕE uma skill (com scripts opcionais). A
 * proposta fica em staging e aparece como card "Adicionar skill" na conversa —
 * só entra em uso quando o usuário aprova no card.
 */
export function createSkillTool() {
  return tool({
    description:
      'Proposes a new Orbit skill: curated knowledge in markdown, optionally accompanied by helper scripts/files the skill uses. The proposal appears as an "Add skill" card in the conversation and is only activated once the user approves it. After calling, briefly explain what the skill does and how it was structured.',
    inputSchema: z.object({
      name: z.string().describe('Display name (e.g.: API Deploy)'),
      description: z.string().describe('Short description of what the skill covers'),
      content: z
        .string()
        .describe(
          'Skill content in markdown. If there are scripts, explain here when and how to run them (relative paths).',
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
    execute: async ({ name, description, content, slug, files }) => {
      try {
        const proposal = await proposeSkill({ name, description, content, slug, files })
        notifySkillsChanged()
        const extras = proposal.files.length
          ? ` com ${proposal.files.length} arquivo(s) auxiliar(es): ${proposal.files.join(', ')}`
          : ''
        return (
          `Skill @${proposal.slug} proposta${extras}. ` +
          'Um card "Adicionar skill" apareceu na conversa — a skill só entra em uso quando o usuário aprovar. ' +
          'Explique agora, em 2-4 frases, o que a skill faz e como usá-la.'
        )
      } catch (err) {
        return `Erro ao propor a skill: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })
}
