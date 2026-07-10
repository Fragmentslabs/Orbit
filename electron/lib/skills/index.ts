import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Skill, SkillSource } from '../../../shared/skills'
import { parseSkill } from './parser'

/**
 * Loader de skills: mescla a fonte global (orbit-data/skills) com a do projeto
 * ({workspace}/.orbit/skills — vence em conflito de nome). Leitura fresca a
 * cada chamada (arquivos pequenos); o watcher da pasta global avisa o renderer
 * para recarregar a paleta.
 */

const EXTENSIONS = new Set(['.skill', '.md'])

export function globalSkillsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'skills')
}

function projectSkillsDir(directory: string): string {
  return path.join(directory, '.orbit', 'skills')
}

async function loadDir(dir: string, source: SkillSource): Promise<Skill[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const entry of entries) {
    if (!EXTENSIONS.has(path.extname(entry).toLowerCase())) continue
    const filePath = path.join(dir, entry)
    try {
      const raw = await fsp.readFile(filePath, 'utf8')
      const skill = parseSkill(raw, source, filePath)
      if (skill) skills.push(skill)
    } catch {
      // arquivo ilegível/corrompido — ignora
    }
  }
  return skills
}

/** Global + projeto mesclados; skill de projeto sobrepõe global de mesmo slug. */
export async function loadSkills(directory?: string): Promise<Skill[]> {
  const bySlug = new Map<string, Skill>()
  for (const skill of await loadDir(globalSkillsDir(), 'global')) bySlug.set(skill.slug, skill)
  if (directory) {
    for (const skill of await loadDir(projectSkillsDir(directory), 'project')) {
      bySlug.set(skill.slug, skill)
    }
  }
  return [...bySlug.values()]
}

/** Observa a pasta global (criações da tool createSkill incluídas) com debounce. */
export function setupSkillsWatcher(onChange: () => void): void {
  const dir = globalSkillsDir()
  fs.mkdirSync(dir, { recursive: true })
  let timer: NodeJS.Timeout | null = null
  try {
    fs.watch(dir, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(onChange, 300)
    })
  } catch (err) {
    console.error('[skills] watcher falhou:', err)
  }
}
