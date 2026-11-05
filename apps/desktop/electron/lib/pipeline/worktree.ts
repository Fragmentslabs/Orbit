import fs from 'node:fs/promises'
import path from 'node:path'
import type { Pipeline, Task, TaskWorktree } from '@shared/pipeline'
import { discardSnapshots } from '../snapshot'
import {
  currentBase,
  branchExists,
  unlinkDependencies,
  git,
  worktreesFolder,
  configuredRoot,
  rootInProject,
  worktreesInsideProject,
  FOLDER_IN_PROJECT,
  prepareDependencies,
  repositoryRoot,
  slug,
} from '../worktrees/core'

// Re-exported: the pipeline and its tests import them from here.
export { findExtras, exists, worktreesFolder, prepareDependencies, repositoryRoot, slug } from '../worktrees/core'

/**
 * Per-task worktree (pipeline with `worktreePerTask`): each task works in its
 * own `git worktree`, on its own branch, in
 * orbit-data/worktrees/<project>/<task>. Git and dependencies come from the
 * core shared with the chats (../worktrees/nucleo).
 */

/** Branch prefix of a pipeline task. Older worktrees use `esteira/` (see legacy origin). */
const BRANCH_PREFIX = 'pipeline'

/**
 * Where a task's worktree is born — follows the "Worktrees folder" preference.
 */
async function worktreeLocation(repo: string, projectId: string, taskId: string): Promise<string> {
  if (worktreesInsideProject()) return path.join(await rootInProject(repo), 'pipeline', taskId)
  return path.join(configuredRoot(), projectId, taskId)
}

/** Task branch: readable in `git branch` and unique through the id suffix. */
export function branchName(task: Pick<Task, 'id' | 'title'>): string {
  return `${BRANCH_PREFIX}/${slug(task.title)}-${task.id.slice(-6).toLowerCase()}`
}

/** Dependency state of the shared core → the pipeline's persisted vocabulary. */
function dependencyState(
  value: 'cloned' | 'linked' | 'none' | 'clonadas' | 'vinculadas' | 'none',
): TaskWorktree['dependencies'] {
  if (value === 'cloned' || value === 'clonadas') return 'cloned'
  if (value === 'linked' || value === 'vinculadas') return 'linked'
  return 'none'
}

/**
 * Creates (or recreates, when the folder is gone) the task's worktree.
 *
 * `base`: where the new branch comes from. If the task's branch already exists
 * (recreation or a repeated name), the worktree just checks it out — the work
 * already committed is still there.
 */
export async function createWorktree(opts: {
  mainFolder: string
  projectId: string
  task: Pick<Task, 'id' | 'title' | 'worktree'>
  base?: string
  /** Branch name when it is not the task's own (the integration branch) */
  branch?: string
  signal?: AbortSignal
}): Promise<TaskWorktree> {
  const repo = await repositoryRoot(opts.mainFolder)
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch {
    throw new Error('The repository has no commit yet — the worktree needs a starting point.')
  }
  const worktreePath =
    opts.task.worktree?.path ?? (await worktreeLocation(repo, opts.projectId, opts.task.id))
  const branch = opts.task.worktree?.branch ?? opts.branch ?? branchName(opts.task)
  const base = opts.task.worktree?.base ?? opts.base ?? (await currentBase(repo))

  // Stale record of a worktree whose folder was deleted by hand: without the
  // prune, `worktree add` refuses the same path.
  await git(repo, ['worktree', 'prune']).catch(() => {})
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  if (await branchExists(repo, branch)) {
    await git(repo, ['worktree', 'add', worktreePath, branch], opts.signal)
  } else {
    await git(repo, ['worktree', 'add', '-b', branch, worktreePath, base], opts.signal)
  }

  const dependencies = await prepareDependencies(repo, worktreePath)
  const relative = path.relative(repo, path.resolve(opts.mainFolder))
  return {
    path: worktreePath,
    folder: relative ? path.join(worktreePath, relative) : worktreePath,
    branch,
    base,
    dependencies: dependencyState(dependencies),
    createdAt: new Date().toISOString(),
  }
}

/** Folder name (and pseudo task id) of a pipeline's integration worktree. */
export const integrationFolderId = (pipelineId: string): string => `integration-${pipelineId}`

/** `pipeline/<name>-<id>/integration`: readable in `git branch`, unique through the id. */
export function integrationBranchName(pipeline: Pick<Pipeline, 'id' | 'name'>): string {
  return `${BRANCH_PREFIX}/${slug(pipeline.name)}-${pipeline.id.slice(-6).toLowerCase()}/integration`
}

/**
 * Creates (or recreates, when the folder is gone) the pipeline's integration
 * worktree. It starts from the pipeline's working branch, or the repository's
 * current one; recreating just checks the existing branch out again.
 */
export function createIntegrationWorktree(opts: {
  mainFolder: string
  projectId: string
  pipeline: Pick<Pipeline, 'id' | 'name' | 'branch' | 'integration'>
  signal?: AbortSignal
}): Promise<TaskWorktree> {
  return createWorktree({
    mainFolder: opts.mainFolder,
    projectId: opts.projectId,
    task: { id: integrationFolderId(opts.pipeline.id), title: opts.pipeline.name, worktree: opts.pipeline.integration },
    branch: integrationBranchName(opts.pipeline),
    base: opts.pipeline.branch?.trim() || undefined,
    signal: opts.signal,
  })
}

/**
 * Removes the task's worktree (folder, git record and snapshots). The branch
 * only goes with `deleteBranch` — without it, the committed work stays
 * reachable. Uncommitted changes in the worktree are lost: the caller confirms.
 */
export async function removeWorktree(
  mainFolder: string | undefined,
  worktree: TaskWorktree,
  opts: { deleteBranch?: boolean; keepSnapshots?: boolean } = {},
): Promise<void> {
  const repo = mainFolder ? await repositoryRoot(mainFolder).catch(() => undefined) : undefined
  // Before git: it walks through the node_modules links and would delete the
  // main repository (see unlinkDependencies).
  await unlinkDependencies(worktree.path)
  if (repo) {
    await git(repo, ['worktree', 'remove', '--force', worktree.path]).catch(() => {})
  }
  await fs.rm(worktree.path, { recursive: true, force: true })
  if (repo) {
    await git(repo, ['worktree', 'prune']).catch(() => {})
    if (opts.deleteBranch) await git(repo, ['branch', '-D', worktree.branch]).catch(() => {})
  }
  if (!opts.keepSnapshots) await discardSnapshots(worktree.folder).catch(() => {})
}

/**
 * Deletes worktrees of tasks that no longer exist (task removed while the app
 * was closed, a removal that failed halfway). `alive`: task ids per project.
 */
export async function cleanOrphans(
  projects: Array<{ id: string; folders: string[] }>,
  alive: Map<string, Set<string>>,
): Promise<void> {
  // Outside the project: the default root and the custom one (the preference may
  // have changed with worktrees already created) hold <project>/<task>.
  for (const root of new Set([worktreesFolder(), configuredRoot()])) {
    let projectFolders: string[]
    try {
      projectFolders = await fs.readdir(root)
    } catch {
      continue // no worktree created here
    }
    for (const projectId of projectFolders) {
      // Only the pipeline's project folders (proj_…): the same root holds the
      // chat worktrees (chats/), which are not ours and must not be swept.
      if (!projectId.startsWith('proj_')) continue
      const project = projects.find((p) => p.id === projectId)
      await sweep(path.join(root, projectId), alive.get(projectId) ?? new Set())
      const repo = project?.folders[0]
        ? await repositoryRoot(project.folders[0]).catch(() => undefined)
        : undefined
      if (repo) await git(repo, ['worktree', 'prune']).catch(() => {})
      if (!project) await fs.rm(path.join(root, projectId), { recursive: true, force: true })
    }
  }
  // Inside the project: <repo>/.orbit/worktrees/pipeline/<task>. The `esteira`
  // folder is the pre-rename location — still swept so old worktrees are cleaned.
  for (const project of projects) {
    const repo = project.folders[0]
      ? await repositoryRoot(project.folders[0]).catch(() => undefined)
      : undefined
    if (!repo) continue
    for (const folder of ['pipeline', 'esteira']) {
      const swept = await sweep(path.join(repo, FOLDER_IN_PROJECT, folder), alive.get(project.id) ?? new Set())
      if (swept) await git(repo, ['worktree', 'prune']).catch(() => {})
    }
  }
}

/** Deletes the task folders without a live task. Returns whether it deleted any. */
async function sweep(folder: string, liveTasks: Set<string>): Promise<boolean> {
  let tasks: string[]
  try {
    tasks = await fs.readdir(folder)
  } catch {
    return false
  }
  let deleted = false
  for (const taskId of tasks) {
    if (liveTasks.has(taskId)) continue
    const worktreePath = path.join(folder, taskId)
    // Safety net: the task list read from disk may have come back empty
    // (corrupted file) — with uncommitted changes, the folder stays.
    const dirty = await git(worktreePath, ['status', '--porcelain']).then(
      (s) => s.length > 0,
      () => false,
    )
    if (dirty) {
      console.warn(`[pipeline] worktree without a task, but with uncommitted changes — kept: ${worktreePath}`)
      continue
    }
    console.log(`[pipeline] removing orphan worktree ${worktreePath}`)
    await fs.rm(worktreePath, { recursive: true, force: true })
    await discardSnapshots(worktreePath).catch(() => {})
    deleted = true
  }
  return deleted
}
