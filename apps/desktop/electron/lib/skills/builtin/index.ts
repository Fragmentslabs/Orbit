import type { Skill } from '@shared/skills'
import { parseSkill } from '../parser'
import webRecon from './web-recon.md?raw'

/**
 * Skills nativas do app: leem o mesmo formato das do usuário (frontmatter +
 * markdown), mas são somente leitura e não ocupam espaço no disco do usuário.
 * Uma skill global ou de projeto com o mesmo slug sobrescreve a nativa.
 */

interface BuiltinSource {
  raw: string
  path: string
}

const SOURCES: BuiltinSource[] = [{ raw: webRecon, path: 'builtin://web_recon' }]

export const BUILTIN_SKILLS: Skill[] = SOURCES.flatMap(({ raw, path }) => {
  const skill = parseSkill(raw, 'builtin', path)
  if (!skill) {
    console.error(`[skills] skill nativa inválida: ${path}`)
    return []
  }
  return [skill]
})
