import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitChangedFile, GitDiffResponse, GitStatusResponse } from '@shared/companion'
import { getGitStatus, getWorkingDiff, getWorkingFileDiff, getWorkingNumstat } from './git'

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

/** Dispatch of the three requests the companion server forwards here. */
export async function handleGitRequest(
  req:
    | { type: 'git:status'; directory: string }
    | { type: 'git:diff'; directory: string; path?: string }
    | { type: 'git:create-branch'; directory: string; branch: string },
): Promise<GitStatusResponse | GitDiffResponse | undefined> {
  switch (req.type) {
    case 'git:status':
      return gitStatusForPhone(req.directory)
    case 'git:diff':
      return gitDiffForPhone(req.directory, req.path)
    case 'git:create-branch':
      await gitCreateBranch(req.directory, req.branch)
      return undefined
  }
}
