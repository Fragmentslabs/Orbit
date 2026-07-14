import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'

/**
 * Engine de snapshots do filesystem por mensagem (padrão opencode): um
 * repositório git auxiliar por projeto em userData/snapshots/<hash>, usando
 * --git-dir + --work-tree para versionar a pasta do projeto sem tocar no
 * .git dele. Snapshots são tree hashes (write-tree) — sem commits, sem refs.
 */

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 50 * 1024 * 1024

/** Excludes padrão além do .gitignore do projeto (projetos sem .gitignore) */
const DEFAULT_EXCLUDES = ['node_modules/', '.git/', 'dist/', 'dist-electron/', 'build/', 'out/', '.next/', 'target/']

const GC_INTERVAL = 60 * 60 * 1000 // 1h
const lastGc = new Map<string, number>()

function gitDirFor(directory: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(directory)).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'snapshots', hash)
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['--git-dir', gitDirFor(directory), '--work-tree', directory, ...args],
    { cwd: directory, maxBuffer: MAX_BUFFER },
  )
  return stdout
}

async function ensureRepo(directory: string): Promise<void> {
  const gitDir = gitDirFor(directory)
  try {
    await fs.access(path.join(gitDir, 'HEAD'))
  } catch {
    await fs.mkdir(gitDir, { recursive: true })
    await execFileAsync('git', ['--git-dir', gitDir, 'init', '--quiet'], { cwd: directory })
    await fs.mkdir(path.join(gitDir, 'info'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'info', 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n', 'utf8')
  }
}

/** git gc --prune=7.days em background, no máximo 1x/hora por projeto. */
function maybeGc(directory: string) {
  const key = gitDirFor(directory)
  const last = lastGc.get(key) ?? 0
  if (Date.now() - last < GC_INTERVAL) return
  lastGc.set(key, Date.now())
  void git(directory, ['gc', '--quiet', '--prune=7.days']).catch(() => {})
}

/** Captura o estado atual do worktree como tree hash. */
export async function capture(directory: string): Promise<string> {
  await ensureRepo(directory)
  await git(directory, ['add', '--all'])
  const tree = (await git(directory, ['write-tree'])).trim()
  maybeGc(directory)
  return tree
}

/**
 * Restaura o worktree para um tree hash. O índice é sincronizado com o
 * estado atual antes (add --all) para que read-tree --reset -u também
 * remova arquivos criados depois do snapshot.
 */
export async function restore(directory: string, tree: string): Promise<void> {
  await ensureRepo(directory)
  await git(directory, ['add', '--all'])
  await git(directory, ['read-tree', '--reset', '-u', tree])
}

export interface SnapshotDiff {
  files: string[]
  /** Diff unificado (pode ser grande — truncado em ~200kB) */
  patch: string
}

const MAX_PATCH_CHARS = 200_000

/** Diferença entre dois snapshots (tree hashes). */
export async function diff(directory: string, from: string, to: string): Promise<SnapshotDiff> {
  const files = (await git(directory, ['diff', '--name-only', from, to]))
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
  let patch = ''
  if (files.length > 0) {
    patch = await git(directory, ['diff', from, to])
    if (patch.length > MAX_PATCH_CHARS) {
      patch = patch.slice(0, MAX_PATCH_CHARS) + '\n… (diff truncado)'
    }
  }
  return { files, patch }
}
