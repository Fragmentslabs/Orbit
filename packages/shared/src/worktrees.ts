/**
 * Worktrees in chats (header selector and the agent's worktree_* tools).
 * The per-task pipeline worktree uses TaskWorktree, in pipeline.ts.
 */

/** Where the worktree came from — it defines what the selector lets one do with it. */
export type WorktreeOrigin =
  /** The main working copy of the repository */
  | 'main'
  /** Created by Orbit's chats (orbit-data/worktrees/chats) */
  | 'chat'
  /** From a pipeline task — the pipeline removes those */
  | 'pipeline'
  /** Created outside Orbit (git worktree add by hand, another tool) */
  | 'external'

export interface WorktreeInfo {
  /** Worktree root */
  path: string
  /** Folder equivalent to the chat's inside it (same subfolder, in a monorepo) */
  folder: string
  name: string
  /** Absent on detached HEAD */
  branch?: string
  /** Current commit, abbreviated */
  head: string
  primary: boolean
  origin: WorktreeOrigin
  /** false when the folder is gone (git still has the record) */
  available: boolean
  locked: boolean
  /** Files with uncommitted changes */
  changes: number
  /** Commits on its branch that the main branch does not have yet */
  ahead: number
}

/** Base value that means "default branch of origin, after a fetch". */
export const BASE_REMOTE = '@remote'

export interface WorktreeList {
  /** Root of the main repository */
  repo: string
  /** Default branch of the remote (e.g. origin/main), when there is one */
  defaultRemote?: string
  /** Root of the worktree in which the queried folder is */
  current: string
  /** The main one comes first */
  worktrees: WorktreeInfo[]
}

export interface CreateWorktreeResult {
  path: string
  /** Folder for the chat to use (the same subfolder it was in) */
  folder: string
  branch: string
  base: string
  dependencies: 'cloned' | 'linked' | 'none'
}

/** Result of the check of the folder chosen for the worktrees. */
export interface ValidateWorktreesFolder {
  exists: boolean
  /** The folder is inside a git repository */
  insideRepository: boolean
  /** A disk other than the home folder: dependencies become links, not clones */
  otherDisk: boolean
}
