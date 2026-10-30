import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BASE_REMOTE,
  type CreateWorktreeResult,
  type WorktreeInfo,
  type WorktreeList,
  type ValidateWorktreesFolder,
} from '@shared/worktrees'
import { killProcess, listProcesses } from '../process-manager'
import { descartarSnapshots } from '../snapshot'
import {
  branchExists,
  configuredRoot,
  currentBase,
  exists,
  git,
  orbitRoots,
  prepareDependencies,
  repositoryRoot,
  rootInProject,
  slug,
  unlinkDependencies,
  worktreesInsideProject,
} from './core'
import { folderInMainRepository } from './main'

/**
 * Worktrees in chats: the worktree selector (header) and the agent's
 * tools (worktree_*) go through here.
 *
 * The list comes from git itself (`git worktree list`), so worktrees created
 * outside Orbit show up too. The ones created by chats live on an `orbit/<name>`
 * branch, and the pipeline tasks' on `pipeline/…` (the pipeline takes care of
 * them; older ones still use the legacy `esteira/` prefix, recognized below).
 * Where they live follows the "Worktrees folder" preference: in Orbit's data
 * folder (chats/<repo>/<name>), in a custom folder (same) or inside the project
 * (.orbit/worktrees/<name>).
 */

const CHATS_FOLDER = 'chats'

/** Folder where this repository's chat worktrees are born, according to the preference. */
async function chatsRoot(repo: string): Promise<string> {
  if (worktreesInsideProject()) return rootInProject(repo)
  return path.join(configuredRoot(), CHATS_FOLDER, repositoryId(repo))
}

/**
 * Default branch of the `origin` remote (e.g. origin/main) — the "updated
 * remote" base. Without the remote HEAD configured, it tries main and master.
 */
async function defaultRemote(repo: string): Promise<string | undefined> {
  try {
    return await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  } catch {
    for (const candidate of ['origin/main', 'origin/master']) {
      if (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`]).then(() => true, () => false)) {
        return candidate
      }
    }
    return undefined
  }
}

/** `<name>-<hash>`: readable in Finder and without colliding between same-named repositories. */
function repositoryId(repo: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 6)
  return `${slug(path.basename(repo))}-${hash}`
}

function isInside(folder: string, root: string): boolean {
  const relative = path.relative(root, folder)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function realPath(folder: string): Promise<string> {
  return fs.realpath(folder).catch(() => path.resolve(folder))
}

interface PorcelainBlock {
  path: string
  head: string
  branch?: string
  bare: boolean
  prunable: boolean
  locked: boolean
}

/** `git worktree list --porcelain`: blocks separated by a blank line. */
export function readPorcelain(output: string): PorcelainBlock[] {
  const blocks: PorcelainBlock[] = []
  for (const block of output.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    const worktreePath = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!worktreePath) continue
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length)
    blocks.push({
      path: worktreePath,
      head: lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
      branch: ref?.replace(/^refs\/heads\//, ''),
      bare: lines.includes('bare'),
      prunable: lines.some((l) => l.startsWith('prunable')),
      locked: lines.some((l) => l.startsWith('locked')),
    })
  }
  return blocks
}

async function countChanges(worktreePath: string): Promise<number> {
  try {
    const output = await git(worktreePath, ['status', '--porcelain'])
    return output ? output.split('\n').length : 0
  } catch {
    return 0
  }
}

async function commitsAhead(repo: string, base: string | undefined, branch: string | undefined): Promise<number> {
  if (!base || !branch || base === branch) return 0
  try {
    return Number(await git(repo, ['rev-list', '--count', `${base}..${branch}`])) || 0
  } catch {
    return 0
  }
}

/**
 * Where the worktree came from. The branch is the main signal — it holds in any
 * folder, including after the location preference changes; the folder breaks the
 * tie for the Orbit ones that had their branch switched.
 */
function originOf(block: PorcelainBlock, main: boolean, roots: string[]): WorktreeInfo['origin'] {
  if (main) return 'main'
  const fromOrbit = roots.some((root) => isInside(block.path, root))
  // `pipeline/` is the current prefix; `esteira/` is the legacy one, kept so
  // worktrees created before the rename are still recognized as pipeline
  // worktrees (and therefore never removed as if they were chat worktrees).
  if ((block.branch?.startsWith('pipeline/') || block.branch?.startsWith('esteira/')) && fromOrbit) return 'pipeline'
  if (block.branch?.startsWith('orbit/') || fromOrbit) return 'chat'
  return 'external'
}

/**
 * Worktrees of the folder's repository, with the state of each one and the equivalent
 * folder in it (the same subfolder the chat is in). null when the folder
 * is not in a git repository.
 */
export async function listWorktrees(folder: string): Promise<WorktreeList | null> {
  const main = await folderInMainRepository(folder)
  let repo: string
  try {
    repo = await repositoryRoot(main)
  } catch {
    return null
  }
  // `path.normalize` on the porcelain paths: git returns them with forward
  // slashes even on Windows, while everything the service builds (and
  // `createChatWorktree`) uses backslashes there. Without this the same list
  // brought two dialects and the raw string comparisons did not match.
  const blocks = readPorcelain(await git(repo, ['worktree', 'list', '--porcelain']))
    .filter((b) => !b.bare)
    .map((b) => ({ ...b, path: path.normalize(b.path) }))
  if (blocks.length === 0) return null

  // Subfolder the chat is in, relative to the current worktree — the equivalent
  // in each worktree is the same subfolder (monorepo).
  const realFolder = await realPath(folder)
  const realRoots = await Promise.all(blocks.map((b) => realPath(b.path)))
  let current = 0
  let best = -1
  realRoots.forEach((root, i) => {
    if (isInside(realFolder, root) && root.length > best) {
      current = i
      best = root.length
    }
  })
  const relative = best >= 0 ? path.relative(realRoots[current], realFolder) : ''

  const roots = orbitRoots(repo)
  const mainBranch = blocks[0].branch
  const worktrees: WorktreeInfo[] = await Promise.all(
    blocks.map(async (block, i): Promise<WorktreeInfo> => {
      const mainOfWorktree = i === 0
      const active = !block.prunable && (await exists(block.path))
      // The chat's subfolder may not exist in another worktree (created only in a
      // branch): then the chat goes to its root, instead of a nonexistent folder.
      const equivalent = relative ? path.join(block.path, relative) : block.path
      return {
        path: block.path,
        folder: equivalent !== block.path && !(await exists(equivalent)) ? block.path : equivalent,
        name: path.basename(block.path),
        branch: block.branch,
        head: block.head.slice(0, 7),
        primary: mainOfWorktree,
        origin: originOf(block, mainOfWorktree, roots),
        available: active,
        locked: block.locked,
        changes: active ? await countChanges(block.path) : 0,
        ahead: mainOfWorktree ? 0 : await commitsAhead(repo, mainBranch, block.branch),
      }
    }),
  )
  return { repo, current: worktrees[current].path, worktrees, defaultRemote: await defaultRemote(repo) }
}

/**
 * Creates a worktree for chats, on an `orbit/<name>` branch from
 * `base` (default: the main repository's current branch). A repeated name gets a suffix.
 */
export async function createChatWorktree(opts: {
  folder: string
  name: string
  base?: string
  signal?: AbortSignal
}): Promise<CreateWorktreeResult> {
  const main = await folderInMainRepository(opts.folder)
  const repo = await repositoryRoot(main)
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch {
    throw new Error('The repository has no commit yet — the worktree needs a starting point.')
  }
  let base = opts.base?.trim()
  if (base === BASE_REMOTE) {
    // "Updated remote" (Claude Code's fresh): starts from the origin's default
    // branch after a fetch, without carrying local commits not yet pushed.
    const remote = await defaultRemote(repo)
    if (!remote) throw new Error('The repository has no "origin" remote with a default branch to start from.')
    await git(repo, ['fetch', 'origin', remote.slice('origin/'.length)], opts.signal).catch(() => {})
    base = remote
  }
  base ||= await currentBase(repo)
  const chatsRootFolder = await chatsRoot(repo)
  const baseName = slug(opts.name)
  let name = baseName
  for (let n = 2; (await branchExists(repo, `orbit/${name}`)) || (await exists(path.join(chatsRootFolder, name))); n++) {
    name = `${baseName}-${n}`
  }
  const worktreePath = path.join(chatsRootFolder, name)
  const branch = `orbit/${name}`

  await git(repo, ['worktree', 'prune']).catch(() => {})
  await fs.mkdir(chatsRootFolder, { recursive: true })
  // --no-track: starting from origin/main, git would set origin/main as the
  // upstream of the new branch, and a push of it would end up in main.
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base], opts.signal)
  const dependencies = await prepareDependencies(repo, worktreePath)

  // The same subfolder as the main one (monorepo): the chat stays where it was.
  const relative = path.relative(repo, await realPath(main))
  const chatFolder = relative && !relative.startsWith('..') ? path.join(worktreePath, relative) : worktreePath
  return { path: worktreePath, folder: chatFolder, branch, base, dependencies }
}

/**
 * Removes a worktree (folder, git record, snapshots and background
 * processes running inside it). The branch only goes away with `deleteBranch`.
 * Refuses the main one and the pipeline ones (the pipeline removes its own).
 *
 * `folder`: a live folder of the same repository (the chat's). The list is
 * queried from it — the worktree to remove may be exactly one whose
 * folder is already gone, and from it git would not find the repository.
 */
export async function removeChatWorktree(opts: {
  folder: string
  path: string
  deleteBranch?: boolean
}): Promise<void> {
  const list = await listWorktrees(opts.folder)
  if (!list) throw new Error('The folder is not in a git repository.')
  const target = list.worktrees.find((w) => path.resolve(w.path) === path.resolve(opts.path))
  if (!target) throw new Error(`Worktree not found: ${opts.path}`)
  if (target.primary) throw new Error('The main repository is not a removable worktree.')
  if (target.origin === 'pipeline') throw new Error('This worktree belongs to a pipeline task — remove it from the pipeline.')

  const realRoot = await realPath(target.path)
  for (const process_ of listProcesses()) {
    if (process_.status === 'running' && process_.cwd && isInside(await realPath(process_.cwd), realRoot)) {
      await killProcess(process_.pid).catch(() => false)
    }
  }
  // Before git: it goes through the node_modules links and would delete the
  // main repository (see unlinkDependencies).
  await unlinkDependencies(target.path)
  await git(list.repo, ['worktree', 'remove', '--force', target.path]).catch(() => {})
  await fs.rm(target.path, { recursive: true, force: true })
  await git(list.repo, ['worktree', 'prune']).catch(() => {})
  if (opts.deleteBranch && target.branch) await git(list.repo, ['branch', '-D', target.branch]).catch(() => {})
  await descartarSnapshots(target.path).catch(() => {})
  if (target.folder !== target.path) await descartarSnapshots(target.folder).catch(() => {})
}

/**
 * Checks the folder chosen for the worktrees (Preferences): inside a
 * repository, they would enter its searches and its status; on a disk other than
 * the home folder (where projects usually live), the dependencies are not
 * cloned copy-on-write and end up linked.
 */
export async function validateWorktreesFolder(folder: string): Promise<ValidateWorktreesFolder> {
  const stat = await fs.stat(folder).catch(() => null)
  if (!stat?.isDirectory()) return { exists: false, insideRepository: false, otherDisk: false }
  const insideRepository = await git(folder, ['rev-parse', '--show-toplevel']).then(() => true, () => false)
  const home = await fs.stat(os.homedir()).catch(() => null)
  return { exists: true, insideRepository, otherDisk: !!home && home.dev !== stat.dev }
}
