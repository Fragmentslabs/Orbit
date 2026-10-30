import type { Memory } from '@shared/memory'
import { isWithinSubproject } from './domain'

/**
 * Map of a project's memory tree — the slice that goes into the system
 * prompt of every new code chat.
 *
 * It used to be only the root node, and the agent had to guess what to search for; or
 * else (in the model before this one) the 15 heaviest memories, loose and without
 * the shape of the tree. The map is the cheap middle ground: the root, the first-level
 * nodes with one line each and, when the chat is in a subfolder, that folder's branch.
 * The rest the agent opens on demand (memory_open / memory_graph), knowing
 * from the map that it exists and where it is.
 */

export interface MapNode {
  id: string
  text: string
  hasDoc: boolean
  /** How many children the node has in the tree — tells the agent it is worth opening. */
  children: number
}

export interface ProjectMap {
  root: MapNode
  /** Direct children of the root, from most to least important. */
  children: MapNode[]
  /** Branch of the subfolder the chat is in, when a scope node covers it. */
  branch?: { subproject: string; node: MapNode; children: MapNode[] }
  /** Project nodes outside the slice — they exist and can be searched. */
  omitted: number
}

/** Root of the tree: the overview of the root scope; without it, the memory with the highest weight. */
export function rootOf(members: Memory[]): Memory | undefined {
  return (
    members.find((m) => m.area === 'overview' && !m.subproject) ??
    [...members].sort((a, b) => b.weight - a.weight)[0]
  )
}

/**
 * Children of each node in a breadth-first walk from the root. The links are
 * bidirectional (relatedIds on both sides), so the parent → child direction comes
 * from the walk order, as in memory_tree.
 */
export function childrenByBfs(
  members: Memory[],
  rootId: string,
): { children: Map<string, string[]>; depth: Map<string, number> } {
  const byId = new Map(members.map((m) => [m.id, m]))
  const depth = new Map([[rootId, 0]])
  const children = new Map<string, string[]>()
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()!
    for (const rel of byId.get(id)?.relatedIds ?? []) {
      if (!byId.has(rel) || depth.has(rel)) continue
      depth.set(rel, depth.get(id)! + 1)
      children.set(id, [...(children.get(id) ?? []), rel])
      queue.push(rel)
    }
  }
  return { children, depth }
}

export function buildProjectMap(members: Memory[], subproject?: string, limit = 12): ProjectMap | null {
  const root = rootOf(members)
  if (!root) return null
  const byId = new Map(members.map((m) => [m.id, m]))
  const { children, depth } = childrenByBfs(members, root.id)

  const node = (m: Memory): MapNode => ({
    id: m.id,
    text: m.text,
    hasDoc: !!m.hasDoc,
    children: children.get(m.id)?.length ?? 0,
  })
  const childrenOf = (id: string) =>
    (children.get(id) ?? [])
      .map((childId) => byId.get(childId)!)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map(node)

  const shown = new Set<string>([root.id])
  const firstLevel = childrenOf(root.id)
  firstLevel.forEach((n) => shown.add(n.id))

  let branch: ProjectMap['branch']
  if (subproject) {
    // The most specific scope node that contains the chat folder: in
    // "front/src", the node "front" wins (and so would a "front/src" if it existed). The
    // children of the node "front" inherit the same folder, so on a tie the shallowest
    // one in the tree wins — otherwise a child created earlier would become the "branch".
    const level = (m: Memory) => depth.get(m.id) ?? Number.MAX_SAFE_INTEGER
    const scope = members
      .filter((m) => m.subproject && m.id !== root.id && isWithinSubproject(subproject, m.subproject))
      .sort((a, b) => b.subproject!.length - a.subproject!.length || level(a) - level(b))[0]
    if (scope) {
      const branchChildren = childrenOf(scope.id)
      shown.add(scope.id)
      branchChildren.forEach((n) => shown.add(n.id))
      branch = { subproject: scope.subproject!, node: node(scope), children: branchChildren }
    }
  }

  return { root: node(root), children: firstLevel, branch, omitted: members.length - shown.size }
}
