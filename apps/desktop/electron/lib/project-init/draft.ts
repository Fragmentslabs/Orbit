import type { ProjectCategory } from '@shared/memory'

/**
 * Draft of the memory tree that the /init coordinator assembles before
 * writing anything.
 *
 * Nothing goes to memory while the analysis runs. The coordinator creates, edits,
 * removes and reorganizes nodes here, reviews the whole set and only then does /init write
 * everything at once. That is what keeps the result from being a pile of loose
 * findings: every node went through the review of whoever saw the whole project, and a
 * cancellation in the middle does not leave half a tree behind.
 *
 * Pure module (no I/O): the shape rules of the tree are testable on their own.
 */

export type DraftCategory = Exclude<ProjectCategory, 'learning'>

export interface DraftNode {
  /** Identifier picked by the coordinator, unique in the draft ("front", "regras-pagamento"). */
  key: string
  title: string
  /** 1–3 sentences that stand on their own — this is what goes into the prompt of future chats. */
  summary: string
  /** The detail (paths, commands, rules, flows), opened on demand with memory_open. */
  document?: string
  category: DraftCategory
  /** Key of another draft node, id of an existing memory, or null at the root. */
  parent: string | null
  /** Cross links: draft keys or existing ids. */
  related: string[]
  /** Folder (relative to the root) this node represents — marks the node of a subproject. */
  scope?: string
  tags: string[]
  /**
   * Search enrichment (see SaveMemoryInput): what makes the node findable by a question that
   * words it differently. Optional — what is missing is derived from the text.
   */
  entities?: string[]
  keywords?: string[]
  concepts?: string[]
  weight?: number
  /** Id of an existing memory this node rewrites, instead of creating another one. */
  updates?: string
}

export interface DraftLearning {
  text: string
  tags: string[]
  title?: string
  keywords?: string[]
  concepts?: string[]
}

export interface Draft {
  nodes: Map<string, DraftNode>
  learnings: DraftLearning[]
  /** Existing memories the coordinator decided to retire, with the reason. */
  retired: Map<string, string>
}

/** What already exists in the project memory when /init runs again. */
export interface ExistingTree {
  ids: Set<string>
  rootId?: string
}

export const SUMMARY_MAX = 320
const SUMMARY_MIN = 20
const KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,59}$/i

export function createDraft(): Draft {
  return { nodes: new Map(), learnings: [], retired: new Map() }
}

/** Trimmed, de-duplicated list; undefined when nothing is left, so the field stays absent. */
export function cleanList(items: string[] | undefined): string[] | undefined {
  const clean = [...new Set((items ?? []).map((s) => s.trim()).filter(Boolean))]
  return clean.length ? clean : undefined
}

function refExists(draft: Draft, existing: ExistingTree, ref: string): boolean {
  return draft.nodes.has(ref) || existing.ids.has(ref)
}

/** Ancestors of a node inside the draft (to block cycles). */
function ancestorsOf(draft: Draft, key: string): string[] {
  const chain: string[] = []
  let current = draft.nodes.get(key)?.parent ?? null
  while (current && draft.nodes.has(current) && !chain.includes(current)) {
    chain.push(current)
    current = draft.nodes.get(current)!.parent
  }
  return chain
}

/**
 * Creates or replaces a node. Returns the error as text (it goes back to the
 * coordinator, which fixes the call) or null.
 *
 * Parents come before children: the parent must already exist in the draft or in
 * memory. That is what forces the tree to be born top-down, with the root
 * thought out before the details.
 */
export function upsertNode(draft: Draft, existing: ExistingTree, node: DraftNode): string | null {
  if (!KEY_PATTERN.test(node.key)) return `invalid key "${node.key}": use letters, numbers, "-", "_", "/" or "." (up to 60).`
  if (!node.title.trim()) return 'empty title.'
  const summary = node.summary.trim()
  if (summary.length < SUMMARY_MIN) return `summary too short in "${node.key}": write something that stands on its own.`
  if (summary.length > SUMMARY_MAX) {
    return `the summary of "${node.key}" has ${summary.length} characters (max. ${SUMMARY_MAX}). Keep the summary short and move the detail to document.`
  }

  if (node.parent === null) {
    const otherRoot = [...draft.nodes.values()].find((n) => n.parent === null && n.key !== node.key)
    if (otherRoot) return `the root "${otherRoot.key}" already exists. There is only one root: hang this node on it or on another node.`
    if (existing.rootId && node.updates && node.updates !== existing.rootId) {
      return `the project root already exists (#${existing.rootId}): the draft root may only update it.`
    }
    // Re-init: the draft root IS the existing root, rewritten. Creating another
    // one would leave the project with two roots and the map pointing at the old one.
    if (existing.rootId) node = { ...node, updates: existing.rootId }
  } else {
    if (node.parent === node.key) return 'a node cannot be its own parent.'
    if (!refExists(draft, existing, node.parent)) {
      return `parent "${node.parent}" does not exist. Create the parent first (top-down) or use the id of an existing memory.`
    }
    if (draft.nodes.has(node.parent) && ancestorsOf(draft, node.parent).includes(node.key)) {
      return `"${node.parent}" is below "${node.key}": that would create a cycle.`
    }
  }

  const unknown = node.related.filter((r) => r !== node.key && !refExists(draft, existing, r))
  if (unknown.length) return `unknown related: ${unknown.join(', ')}.`

  if (node.updates) {
    if (!existing.ids.has(node.updates)) return `updates "${node.updates}" is not an existing memory of this project.`
    const taken = [...draft.nodes.values()].find((n) => n.updates === node.updates && n.key !== node.key)
    if (taken) return `memory #${node.updates} is already updated by node "${taken.key}".`
    if (draft.retired.has(node.updates)) return `#${node.updates} was retired in this draft; undo that before updating it.`
  }

  draft.nodes.set(node.key, {
    ...node,
    title: node.title.trim(),
    summary,
    scope: node.scope?.replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '') || undefined,
    related: [...new Set(node.related.filter((r) => r !== node.key))],
    tags: [...new Set(node.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))],
    entities: cleanList(node.entities),
    keywords: cleanList(node.keywords),
    concepts: cleanList(node.concepts),
  })
  return null
}

/** Removes a node. Refuses when it has children: the coordinator decides where they go. */
export function removeNode(draft: Draft, key: string): string | null {
  if (!draft.nodes.has(key)) return `"${key}" is not in the draft.`
  const children = [...draft.nodes.values()].filter((n) => n.parent === key).map((n) => n.key)
  if (children.length) return `"${key}" has children (${children.join(', ')}): move or remove them first.`
  draft.nodes.delete(key)
  for (const n of draft.nodes.values()) n.related = n.related.filter((r) => r !== key)
  return null
}

export function retireExisting(draft: Draft, existing: ExistingTree, id: string, reason: string): string | null {
  if (!existing.ids.has(id)) return `#${id} is not an existing memory of this project.`
  if (id === existing.rootId) return 'the project root cannot be retired; update it.'
  const updater = [...draft.nodes.values()].find((n) => n.updates === id)
  if (updater) return `#${id} is updated by node "${updater.key}"; it cannot be retired as well.`
  const child = [...draft.nodes.values()].find((n) => n.parent === id)
  if (child) return `node "${child.key}" hangs on #${id}: change its parent first.`
  draft.retired.set(id, reason.trim())
  return null
}

/**
 * Problems that prevent saving. Empty = the draft is ready.
 * With no existing tree, the root is mandatory; with a tree, the draft may only
 * add or update nodes under it.
 */
export function validateDraft(draft: Draft, existing: ExistingTree): string[] {
  const issues: string[] = []
  const nodes = [...draft.nodes.values()]
  const roots = nodes.filter((n) => n.parent === null)
  if (!existing.rootId && roots.length === 0 && nodes.length > 0) {
    issues.push('missing the root: a node with parent null describing the project.')
  }
  if (roots.length > 1) issues.push(`there are ${roots.length} roots; there must be one.`)
  for (const n of nodes) {
    if (n.parent !== null && !refExists(draft, existing, n.parent)) {
      issues.push(`"${n.key}" points at parent "${n.parent}", which does not exist.`)
    }
    if (n.parent !== null && n.parent === n.updates) issues.push(`"${n.key}" is its own parent via updates.`)
    for (const r of n.related) if (!refExists(draft, existing, r)) issues.push(`"${n.key}" links to "${r}", which does not exist.`)
  }
  const scopes = new Map<string, string>()
  for (const n of nodes) {
    if (!n.scope) continue
    const key = n.scope.toLowerCase()
    if (scopes.has(key)) issues.push(`"${n.key}" and "${scopes.get(key)}" represent the same folder "${n.scope}".`)
    scopes.set(key, n.key)
  }
  return issues
}

/** Write order: parents before children, so that each child already has the parent id. */
export function commitOrder(draft: Draft): DraftNode[] {
  const ordered: DraftNode[] = []
  const placed = new Set<string>()
  const pending = [...draft.nodes.values()]
  while (pending.length) {
    const before = pending.length
    for (let i = 0; i < pending.length; i++) {
      const n = pending[i]
      if (n.parent === null || !draft.nodes.has(n.parent) || placed.has(n.parent)) {
        ordered.push(n)
        placed.add(n.key)
        pending.splice(i--, 1)
      }
    }
    // A cycle that escaped validation: write the rest as it is instead of hanging.
    if (pending.length === before) {
      ordered.push(...pending)
      break
    }
  }
  return ordered
}

/** Subproject folder of a node: its own scope or the closest ancestor that has one. */
export function subprojectOf(draft: Draft, key: string): string | undefined {
  let current: DraftNode | undefined = draft.nodes.get(key)
  const seen = new Set<string>()
  while (current && !seen.has(current.key)) {
    if (current.scope) return current.scope
    seen.add(current.key)
    current = current.parent ? draft.nodes.get(current.parent) : undefined
  }
  return undefined
}

/** Short text written to memory: the title opens the line, which is also the label in the graph. */
export function memoryText(node: DraftNode): string {
  return `${node.title}: ${node.summary}`
}

/** The draft as the coordinator sees it: the indented tree, with what each node carries. */
export function renderDraft(draft: Draft, existing: ExistingTree): string {
  const nodes = [...draft.nodes.values()]
  if (nodes.length === 0 && draft.learnings.length === 0 && draft.retired.size === 0) return '(empty draft)'
  const lines: string[] = []
  const visit = (parent: string | null, depth: number) => {
    for (const n of nodes.filter((x) => x.parent === parent)) {
      const marks = [
        n.category,
        n.scope ? `folder ${n.scope}` : '',
        n.document ? `doc ${n.document.length} chars` : 'no doc',
        n.updates ? `updates #${n.updates}` : '',
        n.related.length ? `links ${n.related.join(', ')}` : '',
      ].filter(Boolean)
      lines.push(`${'  '.repeat(depth)}- [${n.key}] ${n.title} (${marks.join('; ')}): ${n.summary}`)
      visit(n.key, depth + 1)
    }
  }
  visit(null, 0)
  // Nodes hanging off memories that already existed (re-init): grouped by parent.
  const underExisting = [...new Set(nodes.map((n) => n.parent).filter((p): p is string => !!p && existing.ids.has(p) && !draft.nodes.has(p)))]
  for (const id of underExisting) {
    lines.push(`- (existing #${id})`)
    visit(id, 1)
  }
  if (draft.learnings.length) {
    lines.push('Learnings (outside the tree, valid for other projects):')
    for (const l of draft.learnings) lines.push(`  - ${l.text}`)
  }
  if (draft.retired.size) {
    lines.push('Existing memories to retire:')
    for (const [id, reason] of draft.retired) lines.push(`  - #${id}: ${reason}`)
  }
  return lines.join('\n')
}
