import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { CreateWorktreeResult } from '@shared/worktrees'
import { getAppSettings } from '../app-settings'
import { userShellEnv } from '../shell-env'

const execFileAsync = promisify(execFile)

/**
 * Worktree core: what the pipeline (worktree per task) and the chats (worktree
 * picker) share — git, names, and carrying the main repository's dependencies
 * over to the worktree.
 *
 * Orbit's worktrees live OUTSIDE the project, in userData/orbit-data/
 * worktrees: inside it, they would show up in the agent's searches, trigger
 * watchers (Vite, dev server) and depend on the user's .gitignore.
 *
 * The worktree shares the repository's .git; the real weight is the
 * node_modules, which do not come along. They are cloned copy-on-write when the
 * filesystem allows it (APFS: nearly instant and nearly no space) and,
 * otherwise, linked to the main repository. The .env* files (ignored by git,
 * but required to run the project) are copied.
 */

/**
 * Folders that are not worth descending into when searching for node_modules and .env. `.orbit`
 * holds the worktrees in "inside the project" mode: descending into it would copy
 * the other worktrees' dependencies into the new worktree.
 */
const IGNORE = new Set(['.git', '.orbit', 'dist', 'dist-electron', 'build', 'out', '.next', 'target', 'coverage', '.turbo', '.expo'])
/** Search depth: root + workspaces (apps/x, packages/y) with some slack. */
const DEPTH = 4
const ENV = /^\.env(\..+)?$/

/** Default root: Orbit's data folder, outside any project. */
export function worktreesFolder(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'worktrees')
}

/** In "inside the project" mode: <repo>/.orbit/worktrees. */
export const FOLDER_IN_PROJECT = path.join('.orbit', 'worktrees')

/**
 * Root configured outside the project (default or custom folder). In
 * "inside the project" mode each repository has its own — see rootInProject.
 */
export function configuredRoot(): string {
  const { local, folder } = getAppSettings().worktrees
  return local === 'custom' && folder ? folder : worktreesFolder()
}

export function worktreesInsideProject(): boolean {
  return getAppSettings().worktrees.local === 'project'
}

/**
 * <repo>/.orbit/worktrees, already outside git: the folder goes into the
 * repository's info/exclude (a local .gitignore, which never goes into any commit). Without
 * that each worktree would show up as thousands of new files in the main one.
 */
export async function rootInProject(repo: string): Promise<string> {
  const root = path.join(repo, FOLDER_IN_PROJECT)
  try {
    const common = path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir']))
    const exclude = path.join(common, 'info', 'exclude')
    const current = await fs.readFile(exclude, 'utf8').catch(() => '')
    if (!current.split('\n').some((line) => line.trim() === '/.orbit/')) {
      await fs.mkdir(path.dirname(exclude), { recursive: true })
      const prefix = current && !current.endsWith('\n') ? '\n' : ''
      await fs.appendFile(exclude, `${prefix}# Worktrees do Orbit\n/.orbit/\n`)
    }
  } catch {
    // With no way to write the exclude, the worktree still works — it just shows up in the status.
  }
  return root
}

/**
 * Every root where Orbit may have put worktrees of this repository: the
 * default one, the current custom one and the project one. It serves to recognize
 * Orbit's worktrees even after the preference changes.
 */
export function orbitRoots(repo: string): string[] {
  const roots = new Set([worktreesFolder(), configuredRoot(), path.join(repo, FOLDER_IN_PROJECT)])
  return [...roots]
}

export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    // Nothing here is interactive: a fetch that asked for a password would hang
    // until the timeout instead of failing right away.
    env: { ...userShellEnv(), GIT_TERMINAL_PROMPT: '0' },
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    signal,
  })
  return stdout.trim()
}

export async function exists(entryPath: string): Promise<boolean> {
  try {
    await fs.access(entryPath)
    return true
  } catch {
    return false
  }
}

/** "Ship cost (v2)!" → "ship-cost-v2" */
export function slug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'task'
  )
}

/** Root of the repository that contains the folder (the folder may be a subfolder). */
export async function repositoryRoot(folder: string): Promise<string> {
  try {
    // path.normalize: git returns the root with forward slashes even on Windows,
    // while everything this service builds uses path.join (backslashes
    // there). Without this the same function delivered two path dialects, and the
    // raw string comparisons did not match on Windows.
    return path.normalize(await git(folder, ['rev-parse', '--show-toplevel']))
  } catch {
    throw new Error(`The main folder is not a git repository: ${folder}`)
  }
}

/** Current branch of the repository; commit when in detached HEAD. */
export async function currentBase(repo: string): Promise<string> {
  const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return branch === 'HEAD' ? git(repo, ['rev-parse', 'HEAD']) : branch
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * node_modules and .env* of the main repository, as relative paths. It does not
 * descend into node_modules (they are handled whole) nor into build folders.
 */
export async function findExtras(root: string): Promise<{ modules: string[]; envs: string[] }> {
  const modules: string[] = []
  const envs: string[] = []
  const descend = async (relative: string, depth: number) => {
    let entries
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') modules.push(entryPath)
        else if (!IGNORE.has(entry.name) && depth < DEPTH) await descend(entryPath, depth + 1)
      } else if (entry.isFile() && ENV.test(entry.name)) {
        envs.push(entryPath)
      }
    }
  }
  await descend('', 1)
  return { modules, envs }
}

/**
 * Clones a folder copy-on-write (APFS on macOS, reflink on Linux). Returns
 * false when the filesystem does not allow it — then the caller links it.
 */
async function clone(source: string, dest: string): Promise<boolean> {
  const args =
    process.platform === 'darwin'
      ? ['-c', '-R', source, dest]
      : process.platform === 'linux'
        ? ['-R', '--reflink=always', source, dest]
        : null
  if (!args) return false
  try {
    await execFileAsync('cp', args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 })
    return true
  } catch {
    // A partial clone (e.g. different volumes) cannot stay: it cleans up and links.
    await fs.rm(dest, { recursive: true, force: true })
    return false
  }
}

/**
 * Carries node_modules and .env* from the main repository to the worktree. What
 * already exists in the worktree (versioned files) is not touched.
 */
export async function prepareDependencies(
  repo: string,
  worktree: string,
): Promise<CreateWorktreeResult['dependencies']> {
  const { modules, envs } = await findExtras(repo)
  for (const env of envs) {
    const dest = path.join(worktree, env)
    if (await exists(dest)) continue
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(path.join(repo, env), dest)
  }
  if (modules.length === 0) return 'none'
  let linked = false
  for (const modulo of modules) {
    const source = path.join(repo, modulo)
    const dest = path.join(worktree, modulo)
    if (await exists(dest)) continue
    await fs.mkdir(path.dirname(dest), { recursive: true })
    if (await clone(source, dest)) continue
    await fs.symlink(source, dest, process.platform === 'win32' ? 'junction' : 'dir')
    linked = true
  }
  return linked ? 'linked' : 'cloned'
}

/** Does not descend here: inside node_modules there is only a copy (or the target of a link,
 *  which was already released before this decision), and walking that is expensive. */
const NO_DESCEND = new Set([...IGNORE, 'node_modules'])

/**
 * Releases the links that `prepareDependencies` created inside the worktree.
 *
 * It exists because of a Windows trap: there the copy-on-write clone is never
 * available (`clone` gives up before trying), so EVERY worktree
 * receives the node_modules as a *junction* to those of the main repository. Node's
 * `fs.rm` knows that a junction is a link and removes it without descending — but
 * `git worktree remove --force` does not: git's own recursive removal
 * goes through the junction and deletes the content of the TARGET, that is, the
 * main repository's node_modules. Unlinking beforehand is what prevents that.
 *
 * It does not descend into any link: what matters is in the worktree tree, and
 * descending into a junction would mean walking inside the main one.
 */
export async function unlinkDependencies(folder: string): Promise<void> {
  const release = async (relative: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(path.join(folder, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = relative ? path.join(relative, entry.name) : entry.name
      // lstat, and not the dirent: on Windows the junction arrives as a link
      // (isSymbolicLink) and not as a folder — that is what distinguishes it from a
      // real node_modules, and it is exactly where git gets it wrong.
      const info = await fs.lstat(path.join(folder, entryPath)).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) {
        // Without `recursive`: removes only the link, never the target.
        await fs.rm(path.join(folder, entryPath), { force: true }).catch(() => {})
        continue
      }
      if (info.isDirectory() && !NO_DESCEND.has(entry.name) && depth < DEPTH) {
        await release(entryPath, depth + 1)
      }
    }
  }
  await release('', 1)
}
