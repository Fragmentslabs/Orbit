import fs from 'node:fs/promises'
import path from 'node:path'
import type { OrchestrationTask } from '@shared/chat'
import { descartarSnapshots } from '../snapshot'
import { folderInMainRepository } from '../worktrees/main'
import {
  findExtras,
  currentBase,
  branchExists,
  unlinkDependencies,
  git,
  prepareDependencies,
  configuredRoot,
  repositoryRoot,
  rootInProject,
  slug,
  worktreesInsideProject,
} from '../worktrees/core'

/**
 * One worktree per orchestra worker ("Isolate workers in worktrees").
 *
 * Each worker works on its own branch (`orchestra/<plan>/<task>`), starting from
 * the chat's branch — or from the dependency's branch, when the task depends on
 * another. Once accepted, its work is committed; at the end, the accepted
 * branches are merged into the chat in dependency order.
 */

export type WorkerWorktree = NonNullable<OrchestrationTask['worktree']>

/** Is the chat folder inside a git repository? (the option only applies then) */
export async function chatRepository(folder: string): Promise<string | null> {
  return repositoryRoot(folder).catch(() => null)
}

/**
 * Creates the worker's worktree. `dependencies` are the worktrees of the tasks
 * it depends on: with one, it starts from that branch; with several, it starts
 * from the first and merges the others (a conflict here is left for the worker
 * to solve, warned in the prompt).
 */
export async function createWorkerWorktree(opts: {
  chatFolder: string
  planId: string
  task: OrchestrationTask
  dependencies: WorkerWorktree[]
}): Promise<{ worktree: WorkerWorktree; notices: string[] }> {
  const repo = await repositoryRoot(opts.chatFolder)
  const notices: string[] = []
  const plan = opts.planId.slice(-6).toLowerCase()
  const name = slug(opts.task.title)
  let branch = `orchestra/${plan}/${name}`
  for (let n = 2; await branchExists(repo, branch); n++) branch = `orchestra/${plan}/${name}-${n}`

  const root = worktreesInsideProject()
    ? path.join(await rootInProject(repo), 'orchestra', plan)
    : path.join(configuredRoot(), 'orchestra', `${slug(path.basename(repo))}-${plan}`)
  const dir = path.join(root, branch.split('/').pop()!)

  const [first, ...others] = opts.dependencies
  const base = first?.branch ?? (await currentBase(opts.chatFolder))
  await fs.mkdir(root, { recursive: true })
  await git(repo, ['worktree', 'prune']).catch(() => {})
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, dir, base])

  for (const dep of others) {
    try {
      await git(dir, ['merge', '--no-edit', dep.branch])
    } catch {
      await git(dir, ['merge', '--abort']).catch(() => {})
      notices.push(`The branch ${dep.branch} (of a task this one depends on) could not be merged on its own — there is a conflict. Merge it with \`git merge ${dep.branch}\` and resolve it before continuing.`)
    }
  }
  await prepareDependencies(repo, dir)

  // The same chat subfolder inside the worktree (monorepo).
  const relative = path.relative(repo, await fs.realpath(opts.chatFolder).catch(() => opts.chatFolder))
  const folder = relative && !relative.startsWith('..') ? path.join(dir, relative) : dir
  return { worktree: { path: dir, folder: folder, branch, base }, notices }
}

/**
 * Commits what the worker left in the worktree — without a commit, the merge at
 * the end would carry nothing. The .env files copied from the main checkout stay
 * out (they are secrets Orbit brought in, not the worker's work).
 */
export async function commitWork(worktree: WorkerWorktree, title: string): Promise<boolean> {
  const status = await git(worktree.path, ['status', '--porcelain']).catch(() => '')
  if (!status) return false
  await git(worktree.path, ['add', '-A'])
  // The .env files Orbit copied come from the MAIN checkout (the worktree root
  // would be itself).
  const repo = await folderInMainRepository(worktree.path)
  const { envs } = await findExtras(repo).catch(() => ({ envs: [] as string[] }))
  if (envs.length > 0) await git(worktree.path, ['reset', '-q', '--', ...envs]).catch(() => {})
  const remaining = await git(worktree.path, ['diff', '--cached', '--name-only']).catch(() => '')
  if (!remaining) return false
  await git(worktree.path, ['commit', '-q', '-m', `orchestra: ${title}`])
  return true
}

export interface MergeResult {
  merged: string[]
  /** Content conflict between a worker's branch and the chat */
  conflict?: { title: string; files: string[] }
  /**
   * Nothing was merged: the chat folder has uncommitted changes in files the
   * workers changed (git would refuse the merge).
   */
  blocked?: { files: string[] }
  /** Another git error (its message) */
  error?: { title: string; message: string }
}

/**
 * Paths of `git status --porcelain` (the destination one, in renames). By regex,
 * not by position: the `git` helper trims the output, and the leading space of
 * the status code on the FIRST line (" M a.txt") disappears.
 */
function statusPaths(status: string): string[] {
  return status
    .split('\n')
    .map((line) => /^[ MADRCTU?!]{1,2}\s+(.+)$/.exec(line)?.[1])
    .filter((c): c is string => !!c)
    .map((c) => c.split(' -> ').pop()!.replace(/^"|"$/g, ''))
}

/**
 * Merges the accepted branches into the chat, in the given order (dependencies
 * first).
 *
 * Before anything, it checks the chat folder: an uncommitted change in a file
 * some worker changed would make git refuse the merge halfway — so nothing is
 * merged and the list of those files comes back, for the user to commit or
 * stash and ask to merge again. On a content conflict, it undoes that merge and
 * stops: the following branches do not go in, so problems are not piled up.
 */
export async function mergeBranches(
  chatFolder: string,
  tasks: Array<{ title: string; worktree: WorkerWorktree }>,
): Promise<MergeResult> {
  const repo = await repositoryRoot(chatFolder)

  const dirty = new Set(statusPaths(await git(repo, ['status', '--porcelain']).catch(() => '')))
  if (dirty.size > 0) {
    const changedByWorkers = new Set<string>()
    for (const t of tasks) {
      const names = await git(repo, ['diff', '--name-only', `HEAD...${t.worktree.branch}`]).catch(() => '')
      for (const name of names.split('\n').filter(Boolean)) changedByWorkers.add(name)
    }
    const atRisk = [...dirty].filter((f) => changedByWorkers.has(f))
    if (atRisk.length > 0) return { merged: [], blocked: { files: atRisk } }
  }

  const merged: string[] = []
  for (const t of tasks) {
    try {
      await git(repo, ['merge', '--no-ff', '--no-edit', '-m', `orchestra: merge ${t.title}`, t.worktree.branch])
      merged.push(t.title)
    } catch (err) {
      const files = (await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
        .split('\n')
        .filter(Boolean)
      await git(repo, ['merge', '--abort']).catch(() => {})
      if (files.length > 0) return { merged, conflict: { title: t.title, files } }
      // No file in conflict: git refused for another reason — its message says
      // which (that is what helps the user, not an empty "conflict").
      const e = err as { stderr?: string; message?: string }
      return { merged, error: { title: t.title, message: (e.stderr || e.message || String(err)).trim().slice(0, 600) } }
    }
  }
  return { merged }
}

/** Removes a worker's worktree once merged (the branch goes with it: it is in the chat). */
export async function removeWorkerWorktree(worktree: WorkerWorktree, deleteBranch: boolean): Promise<void> {
  // The MAIN checkout's git removes the worktree and the branch — from inside
  // the worktree itself, the folder would vanish under the command.
  const main = await folderInMainRepository(worktree.path)
  const repo = main !== path.resolve(worktree.path) ? main : null
  // Before git: it walks through the node_modules links and would delete the
  // main repository (see unlinkDependencies).
  await unlinkDependencies(worktree.path)
  if (repo) await git(repo, ['worktree', 'remove', '--force', worktree.path]).catch(() => {})
  await fs.rm(worktree.path, { recursive: true, force: true })
  if (repo) {
    await git(repo, ['worktree', 'prune']).catch(() => {})
    if (deleteBranch) await git(repo, ['branch', '-d', worktree.branch]).catch(() => {})
  }
  await descartarSnapshots(worktree.folder).catch(() => {})
}

/**
 * Files the worker changed in the worktree since the base (committed,
 * uncommitted and new), relative to the chat folder inside it — the same
 * reference as the task's `arquivos`. Whatever falls outside the subfolder comes
 * out with "../".
 */
export async function worktreeFiles(worktree: WorkerWorktree): Promise<string[]> {
  const changed = await git(worktree.path, ['diff', '--name-only', worktree.base]).catch(() => '')
  const added = await git(worktree.path, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
  return [...new Set(`${changed}\n${added}`.split('\n').map((l) => l.trim()).filter(Boolean))].map((f) =>
    path.relative(worktree.folder, path.join(worktree.path, f)).split(path.sep).join('/'),
  )
}

/** Worker's diff in the worktree: everything since the base, committed or not. */
export async function worktreeDiff(worktree: WorkerWorktree): Promise<string> {
  const files = await git(worktree.path, ['status', '--porcelain']).catch(() => '')
  const patch = await git(worktree.path, ['diff', worktree.base]).catch(() => '')
  return [files ? `Changed files (git status):\n${files}` : '', patch].filter(Boolean).join('\n\n')
}
