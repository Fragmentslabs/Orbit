import type { Skill } from '@shared/skills'
import { parseSkill } from '../parser'
import mediaCompress from './media-compress.md?raw'
import webRecon from './web-recon.md?raw'

/**
 * Built-in skills of the app: they read the same format as the user's skills
 * (frontmatter + markdown), but they are read-only and take no space on the
 * user's disk. A global or project skill with the same slug overrides the built-in.
 */

interface BuiltinSource {
  raw: string
  path: string
}

const SOURCES: BuiltinSource[] = [
  { raw: webRecon, path: 'builtin://web_recon' },
  { raw: mediaCompress, path: 'builtin://media_compress' },
]

export const BUILTIN_SKILLS: Skill[] = SOURCES.flatMap(({ raw, path }) => {
  const skill = parseSkill(raw, 'builtin', path)
  if (!skill) {
    console.error(`[skills] invalid built-in skill: ${path}`)
    return []
  }
  return [skill]
})
