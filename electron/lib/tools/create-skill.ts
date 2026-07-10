import { tool } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { globalSkillsDir } from '../skills'
import { sanitizeSlug, serializeSkill } from '../skills/parser'

export function createSkillTool() {
  return tool({
    description:
      'Cria (ou atualiza) uma skill do Orbit: conhecimento curado em markdown que passa a ser injetado nas próximas conversas e fica acessível pela paleta "/". Use quando o usuário pedir para registrar convenções, padrões ou instruções permanentes.',
    inputSchema: z.object({
      name: z.string().describe('Nome de exibição (ex: Fazer Commit)'),
      description: z.string().describe('Descrição curta do que a skill cobre'),
      content: z.string().describe('Conteúdo da skill em markdown'),
      slug: z
        .string()
        .optional()
        .describe('Slug snake_case para referência @slug (ex: fazer_commit). Se omitido, deriva do nome.'),
    }),
    execute: async ({ name, description, content, slug }) => {
      const safeSlug = slug ? sanitizeSlug(slug) : sanitizeSlug(name)
      if (!safeSlug) return 'Erro: slug inválido.'
      const dir = globalSkillsDir()
      await fsp.mkdir(dir, { recursive: true })
      const filePath = path.join(dir, `${safeSlug}.skill`)
      const existed = await fsp
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      await fsp.writeFile(
        filePath,
        serializeSkill({ name, description, slug: safeSlug, content }),
        'utf8',
      )
      return `Skill @${safeSlug} ${existed ? 'atualizada' : 'criada'} em ${filePath}. Ela será injetada nas próximas mensagens e aparece na paleta "/".`
    },
  })
}
