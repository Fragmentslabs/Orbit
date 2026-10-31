import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SkillProposal } from '@shared/skills'
import { SKILL_SUMMARY_LIMIT, SKILL_TAGS_MAX, SKILL_TAGS_MIN } from '@shared/skills'
import { globalSkillsDir, loadSkillAt } from './index'
import { setCard } from './meta'
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
    .filter((f) => f !== 'skill.md' && f !== CARD_FILE)
}

/** The card the agent wrote with the proposal, kept in staging next to the manifest. */
const CARD_FILE = '.card.json'

interface StagedCard {
  summary: string
  tags: string[]
  lang: string
}

async function readStagedCard(dir: string): Promise<StagedCard | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dir, CARD_FILE), 'utf8')) as Partial<StagedCard>
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.tags)) return null
    return { summary: parsed.summary, tags: parsed.tags.filter((t): t is string => typeof t === 'string'), lang: parsed.lang ?? 'auto' }
  } catch {
    return null
  }
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
  /** The card: ONE line within SKILL_SUMMARY_LIMIT, and the words the user would type. */
  summary?: string
  tags?: string[]
  /** Language the card was written in */
  lang?: string
}

/**
 * The limit is an authoring contract, not a display cut: a summary over it is refused here
 * so the agent rewrites it, instead of the prompt silently cutting it later.
 */
export function validateCard(summary: string, tags: readonly string[]): string | null {
  const flat = summary.trim()
  if (!flat) return 'summary is empty'
  if (/[\r\n]/.test(flat)) return 'summary must be a single line'
  if (flat.length > SKILL_SUMMARY_LIMIT) {
    return `summary has ${flat.length} characters; the limit is ${SKILL_SUMMARY_LIMIT}. Rewrite it shorter.`
  }
  const clean = tags.map((t) => t.trim()).filter(Boolean)
  if (clean.length < SKILL_TAGS_MIN) return `give at least ${SKILL_TAGS_MIN} tags (words the user would type), up to ${SKILL_TAGS_MAX}`
  return null
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
  if (input.summary !== undefined) {
    const problem = validateCard(input.summary, input.tags ?? [])
    if (problem) throw new Error(problem)
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, SKILL_TAGS_MAX)
    await fsp.writeFile(
      path.join(dir, CARD_FILE),
      JSON.stringify({ summary: input.summary.trim(), tags, lang: input.lang ?? 'auto' }),
      'utf8',
    )
  }
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
    ...(input.summary !== undefined ? { summary: input.summary.trim(), tags: input.tags } : {}),
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
      const card = await readStagedCard(dir)
      proposals.push({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        files,
        ...(card ? { summary: card.summary, tags: card.tags } : {}),
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
  const card = await readStagedCard(dir)
  const skillsDir = globalSkillsDir()
  await fsp.mkdir(skillsDir, { recursive: true })

  let finalPath: string
  if (extras.length === 0) {
    // Manifest only → flat .skill file (default format of simple skills)
    finalPath = path.join(skillsDir, `${safeSlug}.skill`)
    await fsp.writeFile(finalPath, raw, 'utf8')
  } else {
    // Bundle with scripts → move the whole folder
    finalPath = path.join(skillsDir, safeSlug)
    await fsp.rm(finalPath, { recursive: true, force: true })
    await fsp.cp(dir, finalPath, { recursive: true })
    await fsp.rm(path.join(finalPath, CARD_FILE), { force: true })
  }
  await fsp.rm(dir, { recursive: true, force: true })
  // The card is written against the file as it NOW is at the destination, so its hash
  // describes what the skill really is (and goes stale the day the file is edited).
  if (card) {
    const skill = await loadSkillAt(finalPath, 'global')
    if (skill) await setCard(skill, { summary: card.summary, tags: card.tags, modelId: 'agent', lang: card.lang })
  }
  return true
}

export async function discardPendingSkill(slug: string): Promise<void> {
  await fsp.rm(path.join(pendingDir(), sanitizeSlug(slug)), { recursive: true, force: true })
}
