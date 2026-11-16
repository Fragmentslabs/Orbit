import type { MediaEntry } from '@orbit/shared'

/**
 * Gallery grouping — the same rule as the desktop's: a photo and its versions are ONE item. The group
 * is by the ROOT of the descent (not by the end of the chain), so two images born from the same base
 * are still one photo with one more version.
 */
export interface MediaGrouping {
  /** One entry per group — the most recent one of it —, in the order of `visible`. */
  covers: MediaEntry[]
  /** cover id → versions of the group, oldest to current. Only groups with more than one image. */
  versions: Map<string, MediaEntry[]>
}

/** Goes up to the origin. `all` (not only what is visible) because a link hidden by a filter cannot split the group. */
export function rootIdOf(entry: MediaEntry, byId: Map<string, MediaEntry>): string {
  const seen = new Set<string>()
  let current = entry
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parentId)
    if (!parent) break
    current = parent
  }
  return current.id
}

export function groupMediaByRoot(all: MediaEntry[], visible: MediaEntry[]): MediaGrouping {
  const byId = new Map(all.map((e) => [e.id, e]))
  const groups = new Map<string, MediaEntry[]>()
  for (const entry of visible) {
    const root = rootIdOf(entry, byId)
    const members = groups.get(root) ?? []
    members.push(entry)
    groups.set(root, members)
  }
  const coverByRoot = new Map<string, string>()
  const versions = new Map<string, MediaEntry[]>()
  for (const [root, members] of groups) {
    const ordered = [...members].sort((a, b) => a.createdAt - b.createdAt)
    const cover = ordered[ordered.length - 1]
    coverByRoot.set(root, cover.id)
    if (ordered.length > 1) versions.set(cover.id, ordered)
  }
  // Keeps the order of `visible` (the gallery delivers the most recent first).
  const covers = visible.filter((entry) => coverByRoot.get(rootIdOf(entry, byId)) === entry.id)
  return { covers, versions }
}

/**
 * Ids to delete when an ITEM of the grid is deleted: the whole group, because the item IS the group —
 * leaving the versions behind would fill the disk with images that show up nowhere. The photo the user
 * attached stays: it is the origin, not a version produced here.
 */
export function expandToGroups(ids: string[], all: MediaEntry[]): string[] {
  const byId = new Map(all.map((e) => [e.id, e]))
  const roots = new Set<string>()
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry) roots.add(rootIdOf(entry, byId))
  }
  const target = new Set(ids)
  for (const entry of all) {
    if (!roots.has(rootIdOf(entry, byId))) continue
    if (entry.source === 'user') continue
    target.add(entry.id)
  }
  return [...target]
}
