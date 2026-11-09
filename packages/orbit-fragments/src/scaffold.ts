import fsp from 'node:fs/promises'
import path from 'node:path'
import { FRAGMENT_KINDS, type FragmentKind } from '@orbit/shared/fragments'
import { scaffoldFiles } from './templates'

export interface ScaffoldOptions {
  /** Folder to create. It must not exist or must be empty. */
  dir: string
  /** Display name; defaults to the folder's name. */
  name?: string
  kind?: FragmentKind
}

function slugOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'fragment'
}

function titleOf(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** Writes a small working fragment (manifest, entry page, script, styles) and returns the files it created. */
export async function scaffoldFragment(options: ScaffoldOptions): Promise<string[]> {
  const dir = path.resolve(options.dir)
  const kind = options.kind ?? 'screen'
  if (!FRAGMENT_KINDS.includes(kind)) throw new Error(`kind must be one of: ${FRAGMENT_KINDS.join(', ')}`)

  const existing = await fsp.readdir(dir).catch(() => null)
  if (existing && existing.length > 0) throw new Error(`${dir} is not empty`)

  const slug = slugOf(path.basename(dir))
  const name = (options.name ?? titleOf(slug)).trim()
  if (!name) throw new Error('name cannot be empty')

  const files = scaffoldFiles({ name, kind, slug })
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, 'utf8')
  }
  return Object.keys(files)
}
