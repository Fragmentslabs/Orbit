import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  FRAGMENT_MAX_FILES,
  validateFragmentFiles,
  validateFragmentManifest,
  type FragmentFileInfo,
  type FragmentIssue,
} from '@orbit/shared/fragment-rules'

export interface ValidationReport {
  dir: string
  /** Number of files found under `src/`. */
  files: number
  issues: FragmentIssue[]
  ok: boolean
}

/** Pages are served with a closed CSP: a remote URL in markup or styles never loads. */
const EXTERNAL_REFERENCE = /(?:\b(?:src|href)\s*=\s*["']|url\(\s*["']?|@import\s+["'])\s*(?:https?:)?\/\//gi
const TEXT_WITH_REFERENCES = new Set(['html', 'css', 'svg'])

/** Everything under `src/` as the validator sees it. Symlinks are listed so they can be refused. */
async function walk(base: string): Promise<{ files: FragmentFileInfo[]; symlinks: string[] }> {
  const files: FragmentFileInfo[] = []
  const symlinks: string[] = []
  async function visit(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(base, full).split(path.sep).join('/')
      if (entry.isSymbolicLink()) symlinks.push(rel)
      else if (entry.isDirectory()) {
        // Counting stops well past the limit: a runaway folder must not make the check slow.
        if (files.length <= FRAGMENT_MAX_FILES * 4) await visit(full)
      } else if (entry.isFile()) files.push({ path: rel, bytes: (await fsp.stat(full)).size })
    }
  }
  await visit(base)
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), symlinks }
}

async function checkExternalReferences(base: string, files: readonly FragmentFileInfo[]): Promise<FragmentIssue[]> {
  const issues: FragmentIssue[] = []
  for (const file of files) {
    if (!TEXT_WITH_REFERENCES.has(path.extname(file.path).slice(1).toLowerCase())) continue
    if (file.bytes > 1024 * 1024) continue
    const text = await fsp.readFile(path.join(base, file.path), 'utf8')
    if (EXTERNAL_REFERENCE.test(text)) {
      issues.push({
        severity: 'warning',
        where: `src/${file.path}`,
        message: 'loads a remote URL; fragments run without network access, so it will not load',
      })
    }
    EXTERNAL_REFERENCE.lastIndex = 0
  }
  return issues
}

/** Runs the manifest and file rules the app applies, on a fragment folder (`manifest.json` + `src/`). */
export async function validateFragmentFolder(dir: string): Promise<ValidationReport> {
  const root = path.resolve(dir)
  const issues: FragmentIssue[] = []

  try {
    issues.push(...validateFragmentManifest(JSON.parse(await fsp.readFile(path.join(root, 'manifest.json'), 'utf8'))))
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    issues.push({
      severity: 'error',
      where: 'manifest.json',
      message: missing ? 'not found — a fragment folder needs a manifest.json' : `is not valid JSON (${(error as Error).message})`,
    })
  }

  const srcRoot = path.join(root, 'src')
  let files: FragmentFileInfo[] = []
  try {
    const found = await walk(srcRoot)
    files = found.files
    for (const link of found.symlinks) {
      issues.push({ severity: 'error', where: `src/${link}`, message: 'symbolic links are not allowed' })
    }
    issues.push(...validateFragmentFiles(files), ...(await checkExternalReferences(srcRoot, files)))
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    issues.push({
      severity: 'error',
      where: 'src/',
      message: missing ? 'not found — the code of a fragment lives in src/ (with src/index.html as the entry)' : (error as Error).message,
    })
  }

  return { dir: root, files: files.length, issues, ok: !issues.some((i) => i.severity === 'error') }
}
