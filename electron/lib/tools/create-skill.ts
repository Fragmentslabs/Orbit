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
      'Propõe uma nova skill do Orbit: conhecimento curado em markdown, opcionalmente acompanhado de scripts/arquivos auxiliares que a skill usa. A proposta aparece como card "Adicionar skill" na conversa e só é ativada quando o usuário aprovar. Depois de chamar, explique brevemente o que a skill faz e como foi estruturada.',
    inputSchema: z.object({
      name: z.string().describe('Nome de exibição (ex: Deploy da API)'),
      description: z.string().describe('Descrição curta do que a skill cobre'),
      content: z
        .string()
        .describe(
          'Conteúdo da skill em markdown. Se houver scripts, explique aqui quando e como executá-los (caminhos relativos).',
        ),
      slug: z
        .string()
        .optional()
        .describe('Slug snake_case para referência @slug (ex: deploy_api). Se omitido, deriva do nome.'),
      files: z
        .array(
          z.object({
            path: z.string().describe('Caminho relativo dentro da skill (ex: scripts/deploy.sh)'),
            content: z.string().describe('Conteúdo do arquivo'),
          }),
        )
        .optional()
        .describe('Scripts/arquivos auxiliares que acompanham a skill (opcional)'),
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
