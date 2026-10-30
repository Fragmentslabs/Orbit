import { projectIdOf } from '../memory/domain'
import * as memoryService from '../memory/service'
import { commitOrder, memoryText, subprojectOf, type Draft, type ExistingTree } from './draft'

export interface CommitContext {
  /** Project root folder — it defines the projectId of everything that is written. */
  rootDirectory: string
  existing: ExistingTree
}

export interface CommitResult {
  /** Something was written. */
  saved: boolean
  created: number
  updated: number
  retired: number
  learnings: number
  /** Titles of the nodes written, in tree order. */
  titles: string[]
}

/**
 * Writes the /init draft: nodes top to bottom (each child already finds the
 * parent id), then the cross links, the learnings and the
 * retirements.
 */
export async function commitDraft(draft: Draft, ctx: CommitContext): Promise<CommitResult> {
  const ids = new Map<string, string>()
  const resolve = (ref: string) => (draft.nodes.has(ref) ? ids.get(ref) : ref)
  const titles: string[] = []
  let created = 0
  let updated = 0

  // Depth of each existing node BEFORE writing: that is what tells, among the
  // neighbors of a node, which one was the parent (the links are bidirectional and
  // both ends mark "parent", so the type alone does not give the direction).
  const depthBefore = new Map(
    (await memoryService.tree(projectIdOf(ctx.rootDirectory))).map((n) => [n.id, n.depth]),
  )

  for (const node of commitOrder(draft)) {
    const isRoot = node.parent === null
    const parentId = node.parent ? resolve(node.parent) : undefined
    // Hanging off a node that already existed (re-init): it inherits that node's folder,
    // which the draft does not know about.
    const inheritedSubproject =
      node.parent && !draft.nodes.has(node.parent)
        ? (await memoryService.getFull(node.parent))?.memory.subproject
        : undefined
    const subproject = isRoot ? undefined : (subprojectOf(draft, node.key) ?? inheritedSubproject)
    const weight = node.weight ?? (isRoot ? 0.9 : node.scope ? 0.85 : 0.7)
    const tags = [...new Set([...node.tags, ...(node.scope ? [node.scope.toLowerCase()] : [])])]
    let id: string | undefined

    if (node.updates && ctx.existing.ids.has(node.updates)) {
      const revised = await memoryService.revise(node.updates, {
        text: memoryText(node),
        tags,
        weight,
        category: node.category,
        // Area node of the old /init ("Arquitetura") reused with another
        // title: without clearing the area, the graph would keep labeling by the area.
        area: isRoot ? 'overview' : null,
        subproject,
        document: node.document,
      })
      if (revised) {
        id = revised.id
        updated++
        // Parent changed: the link to the old parent is dropped. Without this, a node moved
        // from under the root to under "Frontend" would stay linked to
        // the root and would show up at the first level of the map, as before.
        const depth = depthBefore.get(revised.id)
        if (parentId && depth != null) {
          for (const neighbor of revised.relatedIds) {
            const neighborDepth = depthBefore.get(neighbor)
            if (
              neighbor !== parentId &&
              neighborDepth != null &&
              neighborDepth < depth &&
              revised.relationTypes?.[neighbor] === 'parent'
            ) {
              await memoryService.unlink(revised.id, neighbor)
            }
          }
        }
      }
    }
    if (!id) {
      const saved = await memoryService.save({
        kind: 'project',
        directory: ctx.rootDirectory,
        subproject,
        text: memoryText(node),
        tags,
        weight,
        category: node.category,
        area: isRoot ? 'overview' : undefined,
        document: node.document,
        dedup: false,
      })
      id = saved.id
      created++
    }
    if (parentId && parentId !== id) await memoryService.link(id, parentId, 'parent')
    ids.set(node.key, id)
    titles.push(node.title)
  }

  for (const node of draft.nodes.values()) {
    const source = ids.get(node.key)
    for (const ref of node.related) {
      const target = resolve(ref)
      if (source && target) await memoryService.link(source, target, 'related')
    }
  }

  for (const learning of draft.learnings) {
    await memoryService.save({
      kind: 'general',
      category: 'learning',
      text: learning.text,
      tags: learning.tags,
      weight: 0.55,
      // It is valid in any project, but recording where it was born anchors the node near
      // the tree it came from on the canvas.
      directory: ctx.rootDirectory,
    })
  }

  // Retiring a node can leave neighbors with no link at all to the tree:
  // they are reattached to the root instead of becoming invisible orphans.
  const draftRoot = [...draft.nodes.values()].find((n) => n.parent === null)
  const rootId = draftRoot ? ids.get(draftRoot.key) : ctx.existing.rootId
  const neighbors = new Set<string>()
  let retired = 0
  for (const id of draft.retired.keys()) {
    const full = await memoryService.getFull(id)
    if (!full) continue
    full.memory.relatedIds.forEach((r) => neighbors.add(r))
    await memoryService.remove(id)
    retired++
  }
  if (rootId) {
    for (const id of neighbors) {
      if (draft.retired.has(id) || id === rootId) continue
      const full = await memoryService.getFull(id)
      if (full && full.memory.kind === 'project' && full.memory.relatedIds.length === 0) {
        await memoryService.link(id, rootId, 'parent')
      }
    }
  }

  return {
    saved: created + updated + retired + draft.learnings.length > 0,
    created,
    updated,
    retired,
    learnings: draft.learnings.length,
    titles,
  }
}
