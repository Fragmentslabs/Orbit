import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Memory, MemoryKind, ProjectCategory } from '@shared/memory'
import { normalizeText } from '@shared/memory'

/**
 * Pure rules of the memory system (zero I/O): project identification,
 * expiry, automatic promotion and dedup hashing. Testable without Electron.
 */

const DAY = 24 * 60 * 60 * 1000

/** Base TTL of memories that expire (seasonal and project/context). */
const BASE_TTL = 30 * DAY

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Stable identity of a project from its directory. On Windows paths are
 * case-insensitive, so we normalize to full lowercase — lowercasing the drive
 * letter alone would still leave "C:/Projects" and "C:/projects" as duplicates.
 */
export function projectIdOf(directory: string): string {
  return sha1(normalizeDirectory(directory))
}

/** Folder in the form projects are compared in: absolute, with "/", no trailing slash and, on Windows, lowercase. */
export function normalizeDirectory(directory: string): string {
  const normalized = path.resolve(directory).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export interface ProjectRoot {
  projectId: string
  /** Folder as stored in the root memory — this is what becomes `directory` on new memories. */
  directory: string
}

/**
 * Project that covers a folder: the folder itself, or the nearest folder above it
 * that already has a memory tree.
 *
 * /init runs in the parent folder ("app/", with "front/" and "backend/" inside) and writes
 * everything under its projectId. Without this walk up, a chat opened directly in
 * "app/front" computed the projectId of "front", found nothing and started from
 * scratch — exactly the context /init exists to avoid asking for again.
 *
 * `subproject` is the relative path to the requested folder ("front", "front/src"),
 * with "/" and the original casing; undefined when the folder is the root itself.
 */
export function pickProjectRoot(
  roots: ProjectRoot[],
  directory: string,
): { root: ProjectRoot; subproject?: string } | null {
  const target = normalizeDirectory(directory)
  let best: { root: ProjectRoot; normalized: string } | null = null
  for (const root of roots) {
    const normalized = normalizeDirectory(root.directory)
    const covers = target === normalized || target.startsWith(`${normalized}/`)
    if (covers && (!best || normalized.length > best.normalized.length)) best = { root, normalized }
  }
  if (!best) return null
  if (target === best.normalized) return { root: best.root }
  // The relative path comes from the real path (not the normalized one) to keep the
  // casing the folder actually has — that is what shows up in the subproject label.
  const relative = path.relative(path.resolve(best.root.directory), path.resolve(directory)).replace(/\\/g, '/')
  return { root: best.root, subproject: relative || undefined }
}

/** `child` is `scope` or sits inside it ("front/src" is in "front"; "frontend" is not). Case-insensitive. */
export function isWithinSubproject(child: string, scope: string): boolean {
  const c = child.toLowerCase().replace(/\/+$/, '')
  const s = scope.toLowerCase().replace(/\/+$/, '')
  return c === s || c.startsWith(`${s}/`)
}

/** Hash of the normalized text — the exact dedup key. */
export function hashText(text: string): string {
  return sha1(normalizeText(text))
}

/**
 * TTL per kind: seasonal and project/context expire in 30d × (1 + weight × 6);
 * every other kind is permanent (null).
 */
export function ttlFor(kind: MemoryKind, weight: number, category?: ProjectCategory): number | null {
  const expires = kind === 'seasonal' || (kind === 'project' && category === 'context')
  if (!expires) return null
  return Math.round(BASE_TTL * (1 + weight * 6))
}

/**
 * Each search hit extends expiry slightly (+7d), capped at 2× the original TTL
 * counted from creation — memories that get used live longer, but not forever.
 */
export function extendedExpiry(memory: Memory): number | null | undefined {
  if (memory.expiresAt == null) return memory.expiresAt
  const ttl = ttlFor(memory.kind, memory.weight, memory.category)
  if (ttl == null) return null
  const cap = memory.createdAt + 2 * ttl
  return Math.min(memory.expiresAt + 7 * DAY, cap)
}

export function isExpired(memory: Memory, now: number): boolean {
  return memory.expiresAt != null && memory.expiresAt < now
}

export interface Promotion {
  kind: MemoryKind
  category?: ProjectCategory
}

/**
 * Automatic promotion (applied by the scheduler, as a safety net for
 * when the agent never got around to asking):
 * - seasonal → general when hits >= 5 OR weight >= 0.85
 * - project/context → decision when hits >= 3 and it has not expired yet
 * Returns the promotion target or null.
 *
 * `general` and not `core`: core is only injected into the chat prompt, and a pattern
 * that keeps repeating matters mostly in the code, where core never reaches.
 */
export function shouldPromote(memory: Memory, now: number): Promotion | null {
  if (isExpired(memory, now)) return null
  if (memory.kind === 'seasonal' && (memory.hits >= 5 || memory.weight >= 0.85)) {
    return { kind: 'general' }
  }
  if (memory.kind === 'project' && memory.category === 'context' && memory.hits >= 3) {
    return { kind: 'project', category: 'decision' }
  }
  return null
}

/** Default weight when the agent does not provide one: low for what expires, high for the rest. */
export function defaultWeight(kind: MemoryKind, category?: ProjectCategory): number {
  return kind === 'seasonal' || (kind === 'project' && category === 'context') ? 0.3 : 0.7
}
