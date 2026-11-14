import fs from 'node:fs/promises'
import path from 'node:path'
import type { SkillCard, SkillMetaView } from '@shared/skills'
import { globalSkillsDir, loadSkills, notifySkillsChanged } from './index'
import { metaViews, pruneOrphanCards, setPref, usageScope } from './meta'
import { NoAuxModelError, optimizeSkill } from './optimize'
import { sanitizeSlug, serializeSkill } from './parser'
import { approvePendingSkill, discardPendingSkill } from './pending'

/**
 * What the Skills screen does to the skills of THIS machine. The IPC handlers (main.ts) and
 * the companion requests of a desktop looking at this machine's Tools screen both call these,
 * so the rules (slug cleaning, bundles, what a built-in may do) are written once.
 */

export interface SkillInput {
  name: string
  description?: string
  content: string
  slug?: string
  oldSlug?: string
}

export type OptimizeSkillResult =
  | { card: SkillCard }
  | { error: 'not-found' | 'no-aux-model' | 'failed'; message?: string }

/** Card state, preferences and usage of each skill (usage in the open repository, else global). */
export async function skillMeta(directory?: string): Promise<SkillMetaView[]> {
  const skills = await loadSkills(directory)
  await pruneOrphanCards()
  return metaViews(skills, await usageScope(directory ? 'code' : 'chat', directory))
}

export async function optimizeSkillBySlug(slug: string, directory?: string, language?: string): Promise<OptimizeSkillResult> {
  const skill = (await loadSkills(directory)).find((s) => s.slug === slug)
  if (!skill || skill.source === 'builtin') return { error: 'not-found' }
  try {
    return { card: await optimizeSkill(skill, { language }) }
  } catch (err) {
    if (err instanceof NoAuxModelError) return { error: 'no-aux-model' }
    return { error: 'failed', message: err instanceof Error ? err.message : String(err) }
  }
}

export function setSkillPref(slug: string, patch: { pin?: boolean; never?: boolean }): Promise<void> {
  return setPref(sanitizeSlug(slug), patch)
}

export async function saveSkill({ name, description, content, slug, oldSlug }: SkillInput): Promise<{ filePath: string } | { error: string }> {
  const safeSlug = slug ? sanitizeSlug(slug) : sanitizeSlug(name)
  if (!safeSlug) return { error: 'Invalid slug — use only lowercase letters, numbers and underscores' }
  const dir = globalSkillsDir()
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${safeSlug}.skill`)
  // If the slug changed on edit, removes the old file
  if (oldSlug && oldSlug !== safeSlug) {
    const safeOld = sanitizeSlug(oldSlug)
    if (safeOld) await fs.unlink(path.join(dir, `${safeOld}.skill`)).catch(() => {})
  }
  await fs.writeFile(filePath, serializeSkill({ name, description: description ?? '', slug: safeSlug, content }), 'utf8')
  return { filePath }
}

export async function removeSkill(slug: string): Promise<void> {
  const dir = globalSkillsDir()
  const safe = sanitizeSlug(slug)
  if (!safe) return
  // A skill can be a flat file (.skill/.md) or a bundle (folder with scripts)
  await fs.unlink(path.join(dir, `${safe}.skill`)).catch(() => {})
  await fs.unlink(path.join(dir, `${safe}.md`)).catch(() => {})
  await fs.rm(path.join(dir, safe), { recursive: true, force: true }).catch(() => {})
}

export async function approveSkill(slug: string): Promise<boolean> {
  const ok = await approvePendingSkill(slug)
  notifySkillsChanged()
  return ok
}

export async function discardSkill(slug: string): Promise<void> {
  await discardPendingSkill(slug)
  notifySkillsChanged()
}
