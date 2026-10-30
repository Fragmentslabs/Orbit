import fsp from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { globalSkillsDir } from './index'
import { parseSkill } from './parser'

/**
 * Skill import. Two accepted formats:
 * 1. Text: .skill/.md file with frontmatter (+ extra files selected
 *    together, which become the bundle).
 * 2. ZIP (the format of .skill files exported by Claude): file with the magic "PK"
 *    containing SKILL.md + scripts — extracted as a bundle, preserving the
 *    structure relative to the manifest folder.
 */

export interface ImportResult {
  imported: boolean
  slug?: string
  error?: string
}

const TEXT_EXTENSIONS = new Set(['.skill', '.md'])

function isZip(buffer: Buffer): boolean {
  return buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

/** Keeps zip entries from escaping the destination folder (path traversal). */
function safeJoin(base: string, relative: string): string | null {
  const resolved = path.resolve(base, relative)
  const rel = path.relative(base, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return resolved
}

async function writeFlatOrBundle(
  slug: string,
  manifestRaw: string,
  extras: Array<{ relPath: string; data: Uint8Array }>,
): Promise<void> {
  const dir = globalSkillsDir()
  await fsp.mkdir(dir, { recursive: true })
  if (extras.length === 0) {
    await fsp.writeFile(path.join(dir, `${slug}.skill`), manifestRaw, 'utf8')
    return
  }
  const bundle = path.join(dir, slug)
  await fsp.rm(bundle, { recursive: true, force: true })
  await fsp.mkdir(bundle, { recursive: true })
  await fsp.writeFile(path.join(bundle, 'skill.md'), manifestRaw, 'utf8')
  for (const extra of extras) {
    const target = safeJoin(bundle, extra.relPath)
    if (!target) continue // malicious/invalid entry — skip
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, extra.data)
  }
}

function importZip(buffer: Buffer): Promise<ImportResult> | ImportResult {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(buffer))
  } catch {
    return { imported: false, error: 'Invalid or corrupted ZIP file.' }
  }
  const names = Object.keys(entries).filter((n) => !n.endsWith('/'))

  // Manifest: SKILL.md (any case), the least nested one when there are several
  const manifestName = names
    .filter((n) => n.split('/').pop()?.toLowerCase() === 'skill.md')
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (!manifestName) {
    return { imported: false, error: 'The package does not contain a SKILL.md — it is not a valid skill.' }
  }

  const raw = strFromU8(entries[manifestName])
  const parsed = parseSkill(raw, 'global', manifestName)
  if (!parsed) {
    return { imported: false, error: 'SKILL.md with no valid frontmatter (---\nname: …\n---).' }
  }

  // Paths relative to the manifest folder (drops the zip root directory)
  const rootPrefix = manifestName.includes('/')
    ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1)
    : ''
  const extras = names
    .filter((n) => n !== manifestName)
    .map((n) => ({
      relPath: n.startsWith(rootPrefix) ? n.slice(rootPrefix.length) : n,
      data: entries[n],
    }))

  return writeFlatOrBundle(parsed.slug, raw, extras).then(() => ({
    imported: true,
    slug: parsed.slug,
  }))
}

/** Reads a chat attachment that may be a skill (.skill text/ZIP, or .md with
 * skill frontmatter) and returns a textual description for the agent — it does
 * NOT write anything to disk (that only happens via create_skill + approval on the card).
 * Returns null when the content is not a valid skill (e.g. a plain .md). */
export function describeSkillAttachment(buffer: Buffer, filename?: string): string | null {
  if (isZip(buffer)) {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(buffer))
    } catch {
      return null
    }
    const names = Object.keys(entries).filter((n) => !n.endsWith('/'))
    const manifestName = names
      .filter((n) => n.split('/').pop()?.toLowerCase() === 'skill.md')
      .sort((a, b) => a.split('/').length - b.split('/').length)[0]
    if (!manifestName) return null
    const raw = strFromU8(entries[manifestName])
    const parsed = parseSkill(raw, 'global', manifestName)
    if (!parsed) return null
    const extras = names.filter((n) => n !== manifestName)
    return [
      `Name: ${parsed.name}`,
      `Description: ${parsed.description}`,
      extras.length ? `Auxiliary files: ${extras.join(', ')}` : '',
      '',
      parsed.content,
    ]
      .filter(Boolean)
      .join('\n')
  }

  let raw: string
  try {
    raw = buffer.toString('utf8')
  } catch {
    return null
  }
  const parsed = parseSkill(raw, 'global', filename ?? 'attachment.skill')
  if (!parsed) return null
  return [`Name: ${parsed.name}`, `Description: ${parsed.description}`, '', parsed.content].join('\n')
}

/** Imports the dialog selection (zip file OR text manifest + extras). */
export async function importSkillSelection(filePaths: string[]): Promise<ImportResult> {
  if (filePaths.length === 0) return { imported: false }

  const manifestPath = filePaths.find((p) => TEXT_EXTENSIONS.has(path.extname(p).toLowerCase()))
  if (!manifestPath) {
    return { imported: false, error: 'Select a .skill or .md file (the skill manifest).' }
  }

  const buffer = await fsp.readFile(manifestPath)
  // Claude .skill file is a ZIP (bundle SKILL.md + scripts)
  if (isZip(buffer)) return importZip(buffer)

  const raw = buffer.toString('utf8')
  const parsed = parseSkill(raw, 'global', manifestPath)
  if (!parsed) {
    return { imported: false, error: 'File with no valid frontmatter (---\nname: …\n---).' }
  }
  const extras = await Promise.all(
    filePaths
      .filter((p) => p !== manifestPath)
      .map(async (p) => ({ relPath: path.basename(p), data: new Uint8Array(await fsp.readFile(p)) })),
  )
  await writeFlatOrBundle(parsed.slug, raw, extras)
  return { imported: true, slug: parsed.slug }
}
