import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SkillProposal } from '@shared/skills'
import { globalSkillsDir } from './index'
import { parseSkill, sanitizeSlug, serializeSkill } from './parser'

/**
 * Agent skill proposals (create_skill tool): they stay in staging
 * (orbit-data/skills-pending/<slug>/) until the user clicks "Add skill"
 * on the conversation card. Approving moves them to the skills folder (bundle
 * when there are auxiliary files, a flat .skill file when it is only the manifest).
 */

function pendingDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'skills-pending')
}

/** Files (not directories) of a proposal, relative and without the manifest. */
async function listProposalFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/'))
    .filter((f) => f !== 'skill.md')
}

/** Prevents path traversal in the auxiliary files of the proposal. */
function safeRelative(base: string, relative: string): string {
  const resolved = path.resolve(base, relative)
  const rel = path.relative(base, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`invalid file path in the skill: ${relative}`)
  }
  return resolved
}

export interface ProposeSkillInput {
  name: string
  description: string
  content: string
  slug?: string
  files?: Array<{ path: string; content: string }>
}

export async function proposeSkill(input: ProposeSkillInput): Promise<SkillProposal> {
  const slug = sanitizeSlug(input.slug || input.name)
  if (!slug) throw new Error('invalid slug')
  const dir = path.join(pendingDir(), slug)
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'skill.md'),
    serializeSkill({ name: input.name, description: input.description, slug, content: input.content }),
    'utf8',
  )
  const files = input.files ?? []
  for (const file of files) {
    const target = safeRelative(dir, file.path)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, file.content, 'utf8')
  }
  return {
    slug,
    name: input.name,
    description: input.description,
    content: input.content,
    files: files.map((f) => f.path),
  }
}

export async function listPendingSkills(): Promise<SkillProposal[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(pendingDir())
  } catch {
    return []
  }
  const proposals: SkillProposal[] = []
  for (const slug of entries) {
    const dir = path.join(pendingDir(), slug)
    try {
      const raw = await fsp.readFile(path.join(dir, 'skill.md'), 'utf8')
      const skill = parseSkill(raw, 'global', path.join(dir, 'skill.md'))
      if (!skill) continue
      const files = await listProposalFiles(dir)
      proposals.push({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        files,
      })
    } catch {
      // corrupted proposal — ignore
    }
  }
  return proposals
}

/** Moves the approved proposal to the skills folder (the watcher tells the renderer). */
export async function approvePendingSkill(slug: string): Promise<boolean> {
  const safeSlug = sanitizeSlug(slug)
  const dir = path.join(pendingDir(), safeSlug)
  const manifest = path.join(dir, 'skill.md')
  let raw: string
  try {
    raw = await fsp.readFile(manifest, 'utf8')
  } catch {
    return false
  }
  const extras = await listProposalFiles(dir)
  const skillsDir = globalSkillsDir()
  await fsp.mkdir(skillsDir, { recursive: true })

  if (extras.length === 0) {
    // Manifest only → flat .skill file (default format of simple skills)
    await fsp.writeFile(path.join(skillsDir, `${safeSlug}.skill`), raw, 'utf8')
  } else {
    // Bundle with scripts → move the whole folder
    const target = path.join(skillsDir, safeSlug)
    await fsp.rm(target, { recursive: true, force: true })
    await fsp.cp(dir, target, { recursive: true })
  }
  await fsp.rm(dir, { recursive: true, force: true })
  return true
}

export async function discardPendingSkill(slug: string): Promise<void> {
  await fsp.rm(path.join(pendingDir(), sanitizeSlug(slug)), { recursive: true, force: true })
}
