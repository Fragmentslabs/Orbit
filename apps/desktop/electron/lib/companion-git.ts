import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitChangedFile, GitDiffResponse, GitStatusResponse } from '@shared/companion'
import type { GitCommit, GitInfoResponse, GitLogResponse, GitSyncResponse } from '@shared/companion'
import {
  commitAll,
  getBranchInfo,
  getCommitFileDiff,
  getGitLog,
  getGitStatus,
  getWorkingDiff,
  getWorkingFileDiff,
  getWorkingNumstat,
  initRepo,
  pullRepo,
  pushRepo,
} from './git'

/**
 * Git reads and writes the phone asks for (Changes, Diff, branch create). They reuse the
 * very functions behind the desktop's `git:*` IPC, so both apps show the same files, the
 * same counts and the same patch; each function throws with the message the phone shows.
 */

const execFileAsync = promisify(execFile)

/** A patch the phone can render without choking: past this it is cut at a line boundary. */
export const MAX_PATCH_CHARS = 1_500_000

/** Rejects names git itself would refuse, and anything that could be read as an option. */
export function isValidBranchName(name: string): boolean {
  if (!name || name.startsWith('-') || name.length > 200) return false
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  if (name === '@') return false
  return !name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
}

export function capPatch(patch: string): GitDiffResponse {
  if (patch.length <= MAX_PATCH_CHARS) return { patch }
  const cut = patch.lastIndexOf('\n', MAX_PATCH_CHARS)
  return { patch: patch.slice(0, cut > 0 ? cut : MAX_PATCH_CHARS), truncated: true }
}

export async function gitStatusForPhone(directory: string): Promise<GitStatusResponse> {
  const [status, numstat, branch] = await Promise.all([
    getGitStatus(directory),
    getWorkingNumstat(directory),
    execFileAsync('git', ['branch', '--show-current'], { cwd: directory }).then(
      (r) => r.stdout.trim(),
      () => '',
    ),
  ])
  if (!status.ok) throw new Error(status.error)
  const stats = numstat.ok ? numstat.stats : {}
  const files: GitChangedFile[] = status.entries.map((entry) => {
    const stat = stats[entry.path]
    return stat ? { ...entry, added: stat.added, deleted: stat.deleted } : { ...entry }
  })
  return { files, branch }
}

export async function gitDiffForPhone(directory: string, path?: string): Promise<GitDiffResponse> {
  const res = path ? await getWorkingFileDiff(directory, path) : await getWorkingDiff(directory)
  if (!res.ok) throw new Error(res.error)
  return capPatch(res.patch)
}

export async function gitCreateBranch(directory: string, branch: string): Promise<void> {
  const name = branch.trim()
  if (!isValidBranchName(name)) throw new Error('Invalid branch name')
  // Same command as the desktop's 'git:createBranch'; the working changes come along.
  await execFileAsync('git', ['checkout', '-b', name], { cwd: directory })
}

export async function gitLogForPhone(directory: string, skip = 0): Promise<GitLogResponse> {
  const res = await getGitLog(directory, Math.max(0, Math.floor(skip)))
  if (!res.ok) throw new Error(res.error)
  return { commits: res.commits as GitCommit[], hasMore: res.hasMore }
}

/** A hash as git prints it; anything else could be read as an option or a range. */
export function isValidHash(hash: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(hash)
}

export async function gitCommitDiffForPhone(directory: string, hash: string, path: string): Promise<GitDiffResponse> {
  if (!isValidHash(hash)) throw new Error('Invalid commit')
  const res = await getCommitFileDiff(directory, hash, path)
  if (!res.ok) throw new Error(res.error)
  return capPatch(res.patch)
}

export async function gitInfoForPhone(directory: string): Promise<GitInfoResponse> {
  // getBranchInfo swallows git's errors (it was written for a badge), so a folder without git
  // would come back looking like an empty repository: the work-tree check says it plainly.
  const isRepo = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: directory }).then(
    (r) => r.stdout.trim() === 'true',
    () => false,
  )
  if (!isRepo) {
    return { isRepo, current: null, defaultBranch: null, ahead: 0, behind: 0, upstream: null, hasRemote: false, dirty: false }
  }
  return { isRepo, ...(await getBranchInfo(directory)) }
}

export async function gitCommitForPhone(directory: string, message: string): Promise<void> {
  const text = message.trim()
  if (!text) throw new Error('The commit message is empty')
  const res = await commitAll(directory, text)
  if (!res.ok) throw new Error(res.error)
}

export async function gitInitForPhone(directory: string): Promise<void> {
  const res = await initRepo(directory)
  if (!res.ok) throw new Error(res.error)
}

/** pull/push keep git's own failure: a result with `ok: false`, not a throw, so the app words it by kind. */
export async function gitSyncForPhone(directory: string, op: 'pull' | 'push'): Promise<GitSyncResponse> {
  return op === 'pull' ? pullRepo(directory) : pushRepo(directory)
}

/** Dispatch of the requests the companion server forwards here. */
export async function handleGitRequest(
  req:
    | { type: 'git:status'; directory: string }
    | { type: 'git:diff'; directory: string; path?: string }
    | { type: 'git:create-branch'; directory: string; branch: string }
    | { type: 'git:log'; directory: string; skip?: number }
    | { type: 'git:commit-diff'; directory: string; hash: string; path: string }
    | { type: 'git:info'; directory: string }
    | { type: 'git:commit'; directory: string; message: string }
    | { type: 'git:init'; directory: string }
    | { type: 'git:pull'; directory: string }
    | { type: 'git:push'; directory: string },
): Promise<GitStatusResponse | GitDiffResponse | GitLogResponse | GitInfoResponse | GitSyncResponse | undefined> {
  switch (req.type) {
    case 'git:status':
      return gitStatusForPhone(req.directory)
    case 'git:diff':
      return gitDiffForPhone(req.directory, req.path)
    case 'git:create-branch':
      await gitCreateBranch(req.directory, req.branch)
      return undefined
    case 'git:log':
      return gitLogForPhone(req.directory, req.skip)
    case 'git:commit-diff':
      return gitCommitDiffForPhone(req.directory, req.hash, req.path)
    case 'git:info':
      return gitInfoForPhone(req.directory)
    case 'git:commit':
      await gitCommitForPhone(req.directory, req.message)
      return undefined
    case 'git:init':
      await gitInitForPhone(req.directory)
      return undefined
    case 'git:pull':
      return gitSyncForPhone(req.directory, 'pull')
    case 'git:push':
      return gitSyncForPhone(req.directory, 'push')
  }
}
