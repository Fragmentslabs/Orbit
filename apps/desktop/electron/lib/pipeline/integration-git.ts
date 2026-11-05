import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '../worktrees/core'

/**
 * The git steps of the integration branch, apart from the engine so they can be
 * tested against real temporary repositories. Nothing here calls a model or
 * touches the task store: every function takes a folder and answers with data.
 *
 * Paths coming out of `status` and `diff --name-only` are relative to the
 * repository root in both, so they compare directly.
 */

/** Files with uncommitted changes (modified, staged, untracked), by repository-relative path. */
export async function dirtyFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const raw = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal).catch(() => '')
  return pathsFromPorcelain(raw)
}

/**
 * Paths of `status --porcelain=v1 -z`. Each entry is `XY <path>`; a rename or
 * copy is followed by one more field with the origin, which is skipped.
 */
export function pathsFromPorcelain(status: string): string[] {
  const fields = status.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    // By regex, not by position: the `git` helper trims the output, and the
    // leading space of the first status code (" M a.txt") disappears.
    const entry = /^[ MADRCTU?!]{1,2}\s+(.+)$/s.exec(field)?.[1]
    if (field.trimStart()[0] === 'R' || field.trimStart()[0] === 'C') i++
    if (entry) paths.push(entry)
  }
  return paths
}

/** Files git lists as unmerged (a merge stopped on them). */
export async function unmergedFiles(cwd: string): Promise<string[]> {
  const raw = await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
  return raw.split('\n').filter(Boolean)
}

export async function head(cwd: string, ref = 'HEAD'): Promise<string> {
  return git(cwd, ['rev-parse', ref])
}

/** Whether a merge is in progress (MERGE_HEAD exists). */
export async function mergeInProgress(cwd: string): Promise<boolean> {
  return git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
    () => true,
    () => false,
  )
}

export async function abortMerge(cwd: string): Promise<void> {
  await git(cwd, ['merge', '--abort']).catch(() => {})
}

export type MergeStep =
  | { status: 'up-to-date' }
  | { status: 'merged'; hash: string }
  | { status: 'conflict'; files: string[] }
  | { status: 'error'; message: string }

const errorText = (err: unknown): string => {
  const e = err as { stderr?: string; stdout?: string; message?: string }
  return (e.stderr || e.stdout || e.message || String(err)).trim().slice(0, 800)
}

/**
 * `git merge` of `ref` into the branch checked out in `cwd`. A content conflict
 * leaves the merge IN PROGRESS (the caller resolves or aborts it); any other
 * refusal is reported as an error with the merge aborted.
 */
export async function mergeRef(
  cwd: string,
  ref: string,
  opts: { noFf?: boolean; message?: string; signal?: AbortSignal } = {},
): Promise<MergeStep> {
  const before = await head(cwd)
  const args = ['merge', '--no-edit']
  if (opts.noFf) args.push('--no-ff')
  if (opts.message) args.push('-m', opts.message)
  args.push(ref)
  try {
    await git(cwd, args, opts.signal)
  } catch (err) {
    const files = await unmergedFiles(cwd)
    if (files.length > 0) return { status: 'conflict', files }
    await abortMerge(cwd)
    return { status: 'error', message: errorText(err) }
  }
  const after = await head(cwd)
  return after === before ? { status: 'up-to-date' } : { status: 'merged', hash: after }
}

const MARKER = /^(<{7}|>{7})(?: |$)|^={7}$/m

/** Files (of those given) that still contain conflict markers. */
export async function filesWithMarkers(cwd: string, files: string[]): Promise<string[]> {
  const bad: string[] = []
  for (const file of files) {
    const content = await fs.readFile(path.join(cwd, file), 'utf8').catch(() => '')
    if (MARKER.test(content)) bad.push(file)
  }
  return bad
}

/**
 * Concludes a merge the model resolved: stages what changed (never `.env*`) and
 * commits with the merge message git prepared. Throws when markers remain.
 */
export async function concludeMerge(cwd: string, conflicted: string[]): Promise<string> {
  const stuck = await filesWithMarkers(cwd, conflicted)
  if (stuck.length > 0) throw new Error(`Conflict markers remain in: ${stuck.join(', ')}`)
  const paths = (await dirtyFiles(cwd)).filter((f) => !/(^|\/)\.env(\.|$)/.test(f))
  if (paths.length > 0) await git(cwd, ['add', '-A', '--', ...paths])
  const left = await unmergedFiles(cwd)
  if (left.length > 0) throw new Error(`Files still unmerged: ${left.join(', ')}`)
  await git(cwd, ['commit', '--no-edit'])
  return head(cwd)
}

/** Files the branch changed relative to where it diverged from `base` (three-dot). */
export async function changedByBranch(cwd: string, base: string, branch: string): Promise<string[]> {
  const raw = await git(cwd, ['diff', '--name-only', `${base}...${branch}`]).catch(() => '')
  return raw.split('\n').filter(Boolean)
}

/** Files in the way: uncommitted in the integration AND changed by the task's branch. */
export async function overlap(integrationPath: string, integrationBranch: string, taskBranch: string): Promise<string[]> {
  const dirty = await dirtyFiles(integrationPath)
  if (dirty.length === 0) return []
  const changed = new Set(await changedByBranch(integrationPath, integrationBranch, taskBranch))
  return dirty.filter((f) => changed.has(f))
}

// ─── Branches and delivery ───────────────────────────────────────────────────

export async function localBranches(cwd: string): Promise<string[]> {
  const raw = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '')
  return raw.split('\n').filter(Boolean)
}

/** Folder where a branch is checked out (main checkout or any worktree), if anywhere. */
export async function checkedOutAt(repo: string, branch: string): Promise<string | undefined> {
  const raw = await git(repo, ['worktree', 'list', '--porcelain']).catch(() => '')
  let current: string | undefined
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}`) return current
  }
  return undefined
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).then(
    () => true,
    () => false,
  )
}

export type FastForward =
  | { status: 'moved'; hash: string }
  | { status: 'blocked'; files: string[]; where: string }
  | { status: 'failed'; message: string }

/**
 * Moves `destination` to `source` (a fast-forward, never anything else).
 *
 * Checked out somewhere: that checkout is fast-forwarded with `merge --ff-only`,
 * unless it has uncommitted changes in files the move would touch (then nothing
 * moves and the files are listed). Not checked out anywhere: only the ref moves,
 * with the old value as a guard, and no working tree is involved.
 */
export async function fastForward(repo: string, destination: string, source: string): Promise<FastForward> {
  if (!(await isAncestor(repo, destination, source))) {
    return { status: 'failed', message: `"${destination}" has commits the integration does not have.` }
  }
  const target = await head(repo, source)
  const where = await checkedOutAt(repo, destination)
  try {
    if (where) {
      const dirty = await dirtyFiles(where)
      if (dirty.length > 0) {
        const incoming = new Set(
          (await git(repo, ['diff', '--name-only', destination, source]).catch(() => '')).split('\n').filter(Boolean),
        )
        const atRisk = dirty.filter((f) => incoming.has(f))
        if (atRisk.length > 0) return { status: 'blocked', files: atRisk, where }
      }
      await git(where, ['merge', '--ff-only', source])
    } else {
      const old = await head(repo, `refs/heads/${destination}`)
      await git(repo, ['update-ref', `refs/heads/${destination}`, target, old])
    }
  } catch (err) {
    return { status: 'failed', message: errorText(err) }
  }
  return { status: 'moved', hash: await head(repo, `refs/heads/${destination}`) }
}

/** What one merged task contributed: its merge commit against the integration before it. */
export async function mergeDiff(repo: string, mergeHash: string): Promise<{ files: string[]; patch: string }> {
  const [names, patch] = await Promise.all([
    git(repo, ['diff', '--name-only', `${mergeHash}^1`, mergeHash]),
    git(repo, ['diff', `${mergeHash}^1`, mergeHash]).catch(() => ''),
  ])
  return { files: names.split('\n').filter(Boolean), patch }
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await git(repo, ['branch', '-D', branch]).catch(() => {})
}
