import path from 'node:path'

/**
 * Guards of `fs:writeFile` — the only channel through which the renderer writes to
 * disk (the files panel).
 *
 * The agent's tools already have `resolveSafePath` ([tools/context.ts]); this is the
 * equivalent for the panel. It is worth recording the honest limit: the workspace's
 * folders live in the renderer (localStorage), so it is the renderer itself that
 * informs the roots here. That is, the containment is a net against a PATH bug —
 * a file opened from one place and saved to another —, not a security
 * boundary. What really limits the damage are the checks for an existing file,
 * `.git` and binary, applied in the handler.
 */

export type PathVerdict =
  | { ok: true; resolved: string }
  | { ok: false; reason: 'outside-workspace' | 'git-internal' }

/** A `.git` segment in any position of the path. */
function touchesGitInternals(resolved: string): boolean {
  return resolved.split(/[\\/]+/).includes('.git')
}

function isInside(root: string, resolved: string): boolean {
  const rel = path.relative(path.resolve(root), resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * May the path be written? Same containment arithmetic as
 * `resolveSafePath`, plus the refusal of the git directory: an accidental save
 * inside `.git` corrupts the repository, and nothing the panel opens to read
 * needs to be rewritten there.
 */
export function checkWritePath(target: string, roots: string[]): PathVerdict {
  const resolved = path.resolve(target)
  if (touchesGitInternals(resolved)) return { ok: false, reason: 'git-internal' }
  const allowed = roots.length > 0 && roots.some((root) => isInside(root, resolved))
  if (!allowed) return { ok: false, reason: 'outside-workspace' }
  return { ok: true, resolved }
}
