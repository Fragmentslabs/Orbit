/**
 * Rules of the project cards, mirroring the desktop's InitProjectCard and FolderHintCard so the
 * phone and the desktop offer the same thing in the same situations.
 */

import type { FolderGitInfoResponse } from '@orbit/shared'
import { normalizePath } from '~/lib/known-folders'

interface SessionLike {
  id: string
  directory?: string
}

/**
 * The "analyze this project" card: only for a folder that nothing has analyzed (`initialized`
 * is false, not unknown), no other chat already works in it, and the person did not dismiss it.
 */
export function shouldOfferInit(args: {
  directory: string
  currentSessionId?: string
  sessions: readonly SessionLike[]
  initialized: boolean | undefined
  running?: boolean
  dismissed: readonly string[]
}): boolean {
  if (args.initialized !== false || args.running) return false
  const dir = normalizePath(args.directory)
  if (args.dismissed.some((d) => normalizePath(d) === dir)) return false
  const hasPreviousChat = args.sessions.some(
    (s) => s.id !== args.currentSessionId && s.directory && normalizePath(s.directory) === dir,
  )
  return !hasPreviousChat
}

/** Repo name suggested from the folder: what the person almost always wants (same as desktop). */
export function suggestRepoName(directory: string): string {
  const base = directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return base.replace(/[^A-Za-z0-9._-]/g, '-')
}

/** Same rule as the desktop (github-repo.ts) — validating here saves a trip to the API. */
export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..'
}

/** Whether the "publish to GitHub" action makes sense: a repo with commits and no remote. */
export function canPublishRepo(info: FolderGitInfoResponse | null | undefined): boolean {
  return !!info && info.exists && info.isRepo && info.hasCommits && !info.remoteUrl
}
