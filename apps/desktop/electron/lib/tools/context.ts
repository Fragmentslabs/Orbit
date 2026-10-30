import path from 'node:path'
import { recordToolWrite } from '../session/write-journal'

/** Snapshot of the turn in progress (code mode): filesystem tree hash
 * captured before the stream starts. Filled in by chat-engine AFTER
 * creating the ToolContext — which is why it is read via closure (getTurnSnapshot),
 * never a fixed field. Tools like verify_changes use it to compare the
 * current state against the start of the turn. */
export interface TurnSnapshot {
  /** Tree hash before the turn starts */
  start?: string
  /** true when the initial capture failed — no start to compare against */
  failed?: boolean
  /** Reason for the initial capture failure */
  error?: string
}

/** Context passed to every tool of an execution. */
export interface ToolContext {
  sessionId: string
  /** Main working folder */
  directory: string
  /** Additional folders attached by the user */
  extraDirectories: string[]
  abort: AbortSignal
  /** Snapshot of the turn in progress (code mode) — it allows reading the
   * filesystem state of the current turn. undefined when the mode does not capture a snapshot
   * or the capture has not happened yet. */
  getTurnSnapshot?: () => TurnSnapshot | undefined
  /** Does this execution's model accept images (vision)? It controls panel_screenshot's
   * `see` flag: false/undefined = the tool returns only the URL, without loading
   * the image into the context. Filled in by whoever assembles the tools. */
  modelVision?: boolean
  /** Delegated vision model (Vision mode): when the main model has no
   * vision, panel_screenshot describes the image with this model and returns the
   * text instead of the image. Filled in by whoever assembles the tools. */
  visionModel?: { providerId: string; modelId: string }
}

export class PathAccessError extends Error {}

/**
 * Resolves a path relative to the main folder and guarantees that the result
 * is inside one of the allowed folders (main or attached) —
 * the same protection opencode applies on external-directory.
 */
export function resolveSafePath(ctx: ToolContext, target: string): string {
  const resolved = path.resolve(ctx.directory, target)
  const roots = [ctx.directory, ...ctx.extraDirectories]
  const allowed = roots.some((root) => {
    const rel = path.relative(path.resolve(root), resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
  if (!allowed) {
    throw new PathAccessError(
      `Access denied: ${resolved} is outside the working folders (${roots.join(', ')})`,
    )
  }
  return resolved
}

/**
 * `resolveSafePath` for a path the tool is going to WRITE (create,
 * overwrite, delete, move here) — a file or a whole folder. It records in the
 * turn's write journal: it is the proof of authorship the revert uses to
 * separate what the agent wrote from what changed in the folder another way.
 */
export function resolveWritePath(ctx: ToolContext, target: string): string {
  const resolved = resolveSafePath(ctx, target)
  recordToolWrite(resolved)
  return resolved
}

// .orbit: Orbit's worktrees in "inside the project" mode — whole copies of the
// repository that would duplicate every search result.
export const IGNORED_DIRS = new Set(['node_modules', '.git', '.orbit', 'dist', 'dist-electron', '.next', 'build', 'out', '.turbo', '.cache'])
