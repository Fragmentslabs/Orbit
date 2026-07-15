import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Skill, SkillSource } from '@shared/skills'
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

/** Lista arquivos de um bundle recursivamente (exceto o manifesto), caminhos absolutos. */
async function listBundleFiles(dir: string, manifestPath: string): Promise<string[]> {
  const files: string[] = []
  async function walk(current: string) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (full !== manifestPath) files.push(full)
    }
  }
  await walk(dir).catch(() => {})
  return files
}

/**
 * Manifesto de um bundle (pasta de skill): skill.md, skill.skill ou
 * <nome-da-pasta>.skill/.md — o primeiro que existir.
 */
async function findManifest(dir: string): Promise<string | null> {
  const base = path.basename(dir)
  for (const candidate of ['skill.md', 'SKILL.md', 'skill.skill', `${base}.skill`, `${base}.md`]) {
    const full = path.join(dir, candidate)
    try {
      await fsp.access(full)
      return full
    } catch {
      // tenta o próximo
    }
  }
  return null
}

async function loadDir(dir: string, source: SkillSource): Promise<Skill[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        // Bundle: pasta com manifesto + scripts/arquivos auxiliares
        const manifestPath = await findManifest(entryPath)
        if (!manifestPath) continue
        const raw = await fsp.readFile(manifestPath, 'utf8')
        const skill = parseSkill(raw, source, manifestPath)
        if (skill) {
          const scripts = await listBundleFiles(entryPath, manifestPath)
          if (scripts.length) skill.scripts = scripts
          skills.push(skill)
        }
      } else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const raw = await fsp.readFile(entryPath, 'utf8')
        const skill = parseSkill(raw, source, entryPath)
        if (skill) skills.push(skill)
      }
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

/** Avisa o renderer para recarregar skills/propostas (mudanças fora do watcher). */
export function notifySkillsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('skills:changed')
  }
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
