import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Skill, SkillSource } from '@shared/skills'
import { parseSkill } from './parser'
import { BUILTIN_SKILLS } from './builtin'

/**
 * Skills loader: merges the built-in sources (read-only), the global one
 * (orbit-data/skills) and the project one ({workspace}/.orbit/skills). Precedence
 * from the most specific to the least: project > global > built-in — the one that
 * overrides is always the user's. Fresh read on every call (small files); the
 * watcher of the global folder tells the renderer to reload the palette.
 */

const EXTENSIONS = new Set(['.skill', '.md'])

export function globalSkillsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'skills')
}

function projectSkillsDir(directory: string): string {
  return path.join(directory, '.orbit', 'skills')
}

/** Lists the files of a bundle recursively (except the manifest), absolute paths. */
export async function listBundleFiles(dir: string, manifestPath: string): Promise<string[]> {
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
 * Manifest of a bundle (skill folder): skill.md, skill.skill or
 * <folder-name>.skill/.md — the first one that exists.
 */
async function findManifest(dir: string): Promise<string | null> {
  const base = path.basename(dir)
  for (const candidate of ['skill.md', 'SKILL.md', 'skill.skill', `${base}.skill`, `${base}.md`]) {
    const full = path.join(dir, candidate)
    try {
      await fsp.access(full)
      return full
    } catch {
      // try the next one
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
        // Bundle: folder with a manifest + helper scripts/files
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
      // unreadable/corrupted file — ignore
    }
  }
  return skills
}

/** One skill from a path: a flat file or the manifest of a bundle folder. */
export async function loadSkillAt(filePath: string, source: SkillSource): Promise<Skill | null> {
  try {
    const stat = await fsp.stat(filePath)
    const dir = stat.isDirectory() ? filePath : null
    const manifestPath = dir ? await findManifest(dir) : filePath
    if (!manifestPath) return null
    const skill = parseSkill(await fsp.readFile(manifestPath, 'utf8'), source, manifestPath)
    if (skill && dir) {
      const scripts = await listBundleFiles(dir, manifestPath)
      if (scripts.length) skill.scripts = scripts
    }
    return skill
  } catch {
    return null
  }
}

/** Built-in + global + project merged; the project one overrides the global one. */
export async function loadSkills(directory?: string): Promise<Skill[]> {
  const bySlug = new Map<string, Skill>()
  for (const skill of BUILTIN_SKILLS) bySlug.set(skill.slug, skill)
  for (const skill of await loadDir(globalSkillsDir(), 'global')) bySlug.set(skill.slug, skill)
  if (directory) {
    for (const skill of await loadDir(projectSkillsDir(directory), 'project')) {
      bySlug.set(skill.slug, skill)
    }
  }
  return [...bySlug.values()]
}

/** Tells the renderer to reload skills/proposals (changes outside the watcher). */
export function notifySkillsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('skills:changed')
  }
}

/** Watches the global folder (createSkill tool writes included) with debounce. */
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
    console.error('[skills] watcher failed:', err)
  }
}
