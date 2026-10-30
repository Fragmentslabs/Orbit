import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { userShellEnv } from '../shell-env'

const execFileAsync = promisify(execFile)

/**
 * Equivalent folder in the MAIN repository for a folder inside a
 * `git worktree` — `<worktree>/apps/web` becomes `<main>/apps/web`.
 *
 * The worktree is another working copy of the SAME project, but it lives at another
 * path. Everything that identifies the project by its path (project memory, the
 * /init map) would treat each worktree as a new project: without the main
 * one's memories, and with the new ones tied to a path that disappears when the
 * worktree is removed.
 *
 * Outside a worktree (ordinary repository, folder without git, bare repository), the
 * folder comes back as it came. It never throws: in doubt, the original folder.
 */
export async function folderInMainRepository(folder: string): Promise<string> {
  const key = path.resolve(folder)
  const cached = cache.get(key)
  if (cached) return cached
  const resolved = resolve(key)
  cache.set(key, resolved.then((r) => r.folder))
  // Runs every turn (prompt, memory, usage report): the result stays cached.
  // When git fails (folder without a repository, deleted) the answer holds for
  // a minute — the folder may become a repository later, but a report with dozens
  // of chats in deleted folders should not call git once per chat.
  const forget = () => setTimeout(() => cache.delete(key), FAILURE_TTL_MS).unref?.()
  resolved.then((r) => !r.cacheable && forget()).catch(forget)
  return resolved.then((r) => r.folder)
}

const cache = new Map<string, Promise<string>>()
const FAILURE_TTL_MS = 60_000

async function resolve(folder: string): Promise<{ folder: string; cacheable: boolean }> {
  const result = await resolveInGit(folder)
  return result === null ? { folder, cacheable: false } : { folder: result, cacheable: true }
}

/** null = git did not answer (folder without a repository, nonexistent). */
async function resolveInGit(folder: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { cwd: folder, env: userShellEnv(), timeout: 10_000 },
    )
    const [gitDir, commonDir, top] = stdout.trim().split('\n').map((line) => path.resolve(folder, line.trim()))
    if (!gitDir || !commonDir || !top) return folder
    // Same .git on both sides: it is the main repository (or a common one).
    if (gitDir === commonDir) return folder
    // The shared .git of a main one with a working copy ends in
    // ".git"; without that it is a bare repository, which has no folder to go back to.
    if (path.basename(commonDir) !== '.git') return folder
    const mainFolder = path.dirname(commonDir)
    // Real path on both sides: on macOS git returns /private/var/… for
    // what arrived as /var/…, and the relative would give a path full of "..".
    const realPath = await fs.realpath(folder).catch(() => folder)
    const relative = path.relative(top, realPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return folder
    return relative ? path.join(mainFolder, relative) : mainFolder
  } catch {
    return null
  }
}

/** Tests only: forgets what has already been resolved. */
export function clearMainCache(): void {
  cache.clear()
}
