import type { GitSyncResponse } from '@orbit/shared'

/** Which i18n key words a failed pull/push: the kind git's message was sorted into. */
export function syncErrorKey(op: 'pull' | 'push', res: GitSyncResponse): string {
  if (res.kind === 'auth') return 'project.sync.auth'
  if (res.kind === 'noRemote') return 'project.sync.noRemote'
  if (res.kind === 'noUpstream') return op === 'pull' ? 'project.sync.noUpstream' : 'project.sync.failed'
  return 'project.sync.failed'
}

/** "2m", "3h", "5d", "4w", "8mo", "2y": the compact age the commit rows show. */
export function shortAge(iso: string, now = Date.now()): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const seconds = Math.max(0, Math.floor((now - time) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/** A worktree name the desktop accepts without surprises: trimmed, no blank. */
export function cleanWorktreeName(name: string): string {
  return name.trim().replace(/\s+/g, '-')
}

/** Short hash as the desktop shows it. */
export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}
