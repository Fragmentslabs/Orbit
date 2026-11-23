import type {
  BranchesResponse,
  CreateWorktreeResult,
  GitDiffResponse,
  GitInfoResponse,
  GitLogResponse,
  GitStatusResponse,
  GitSyncResponse,
  SessionInfo,
  WorktreeList,
} from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'

/** Thin typed calls over the companion socket for the Changes / Diff / Branch screens. */
async function call<T>(req: Record<string, unknown>, fallback: string): Promise<T> {
  const res = await useConnectionStore.getState().wsClient.send(req as never)
  if (!res.ok) throw new Error(res.error ?? fallback)
  return res.data as T
}

export const gitStatus = (directory: string) =>
  call<GitStatusResponse>({ type: 'git:status', directory }, 'Could not read the changes')

export const gitDiff = (directory: string, path?: string) =>
  call<GitDiffResponse>({ type: 'git:diff', directory, path }, 'Could not read the diff')

export const gitBranches = (directory: string) =>
  call<BranchesResponse>({ type: 'git:branches', directory }, 'Could not read the branches')

export const gitCheckout = (directory: string, branch: string) =>
  call<void>({ type: 'git:checkout', directory, branch }, 'Could not switch branch')

export const gitCreateBranch = (directory: string, branch: string) =>
  call<void>({ type: 'git:create-branch', directory, branch }, 'Could not create the branch')

export const gitLog = (directory: string, skip = 0) =>
  call<GitLogResponse>({ type: 'git:log', directory, skip }, 'Could not read the commits')

export const gitCommitDiff = (directory: string, hash: string, path: string) =>
  call<GitDiffResponse>({ type: 'git:commit-diff', directory, hash, path }, 'Could not read the diff')

export const gitInfo = (directory: string) =>
  call<GitInfoResponse>({ type: 'git:info', directory }, 'Could not read the branch state')

/** Stages everything and commits, like the desktop's Commit button. */
export const gitCommit = (directory: string, message: string) =>
  call<void>({ type: 'git:commit', directory, message }, 'Could not commit')

/** `git init` in a folder that is not a repository yet. */
export const gitInit = (directory: string) =>
  call<void>({ type: 'git:init', directory }, 'Could not start the repository')

/** A failure comes back as a result (with git's message and a kind), not as a throw. */
export const gitPull = (directory: string) =>
  call<GitSyncResponse>({ type: 'git:pull', directory }, 'Could not pull')

export const gitPush = (directory: string) =>
  call<GitSyncResponse>({ type: 'git:push', directory }, 'Could not push')

export const worktreeList = (folder: string) =>
  call<WorktreeList | null>({ type: 'worktree:list', folder }, 'Could not read the worktrees')

export const worktreeCreate = (folder: string, name: string, base?: string) =>
  call<CreateWorktreeResult>({ type: 'worktree:create', folder, name, base }, 'Could not create the worktree')

export const worktreeRemove = (folder: string, path: string, deleteBranch: boolean) =>
  call<void>({ type: 'worktree:remove', folder, path, deleteBranch }, 'Could not remove the worktree')

/** Points the chat at another working folder (a worktree); the next message already runs there. */
export const setSessionDirectory = (sessionId: string, directory: string) =>
  call<SessionInfo>({ type: 'sessions:set-directory', sessionId, directory }, 'Could not switch the folder')

/** Language hint for the highlighter: the extension of the path. */
export function languageOfPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined
}
