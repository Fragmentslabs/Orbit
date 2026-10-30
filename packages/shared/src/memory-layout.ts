/**
 * Layout of the memories canvas — organic graph in the Obsidian style,
 * shared between desktop and mobile.
 *
 * The tree grows to ALL sides from the root, with no fixed direction and no
 * ring: the positions come out of a force simulation (repulsion between all
 * nodes + springs on the edges), seeded by a radial distribution with jitter.
 * That gives the "spread out but organized" look — each branch occupies its region,
 * the distance to the parent varies from node to node, and nothing is aligned in a grid.
 *
 * The only hard rule is the MINIMUM SPACING: after the simulation, a pass of
 * separation resolves overlapping using the box of the LABEL, not only the circle of the
 * node. When a neighborhood gets too tight to fit, the nodes are
 * pushed radially away from the root — it is the "go to a farther level"
 * instead of piling text over text.
 *
 * The layout is deterministic: the random generator is seeded by the group id,
 * so the same memory always lands in the same place across renders and across the
 * two platforms.
 */

import type { Memory } from './memory'
import { jaccard, normalizeText, PROJECT_AREAS } from './memory'

/** Base distance between parent and child — the spring relaxes around this value. */
export const BASE_LINK_DISTANCE = 90
/** Free clearance required between the boxes of any two nodes. */
export const MIN_GAP = 14
/** Height of the label line, used in the collision box. */
export const LABEL_HEIGHT = 14
/** Distance of the label below the node circle. */
export const LABEL_OFFSET = 6
/** Average character width at the font size of the labels. */
const CHAR_WIDTH = 5.6
/** Label cut — the same limit used in the drawing on both platforms. */
export const MAX_LABEL_CHARS = 34
/** Clearance between two different trees (projects). */
export const GROUP_GAP = 120

const INFERRED_JACCARD = 0.5
const MAX_INFERRED_EDGES = 30

/** Synthetic group of the memories that were not born in any project. */
export const GLOBAL_GROUP = '__global__'

export interface LayoutNode {
  memory: Memory
  x: number
  y: number
  /** Distance in hops to the root of the group. */
  depth: number
  /** Root of the group tree (the overview of the project). */
  isRoot: boolean
  /** Effective parent in the coverage tree (undefined at the root and for the floating ones). */
  parentId?: string
  /**
   * Node with no link to the rest of the group. Drawn loose, without an edge —
   * and it is the first to give up space when the neighborhood saturates.
   */
  floating: boolean
  /** Direct children present in the pool — includes the ones hidden by collapse. */
  childCount: number
  collapsed: boolean
  groupId: string
  /** Radius of the drawn circle — the layout owns it because the collision depends on it. */
  r: number
  /** Half width of the label box, for collision and framing. */
  labelHalfWidth: number
}

export type LayoutEdgeKind =
  /** Parent→child edge of the coverage tree — solid stroke. */
  | 'tree'
  /** Real relation that did not become a tree edge (second parent, "related"). */
  | 'cross'
  /** Inferred by tag similarity — always inside the same group. */
  | 'inferred'

export interface LayoutEdge {
  from: string
  to: string
  kind: LayoutEdgeKind
  hits: number
}

export interface LayoutGroup {
  id: string
  label: string
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface MemoryLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  groups: LayoutGroup[]
}

// ---------------------------------------------------------------------------
// Node geometry
// ---------------------------------------------------------------------------

/** Radius of the circle: bigger root, intermediate area, ordinary fact by weight. */
export function nodeRadius(memory: Memory, isRoot: boolean): number {
  if (isRoot) return 22
  if (memory.area) return 14
  return 7 + memory.weight * 4
}

/** Label text with the standard cut — the same on both platforms. */
export function nodeLabelText(memory: Memory, isRoot: boolean): string {
  if (isRoot && memory.projectName) return memory.projectName
  if (memory.area) return PROJECT_AREAS[memory.area]?.label ?? memory.text
  return memory.text.length > MAX_LABEL_CHARS
    ? `${memory.text.slice(0, MAX_LABEL_CHARS)}…`
    : memory.text
}

function labelHalfWidthOf(text: string): number {
  return (Math.min(text.length, MAX_LABEL_CHARS + 1) * CHAR_WIDTH) / 2
}

/**
 * Collision box of the node: the circle joined to the label centered right below it.
 * It is this box — and not the radius — that the separation uses, because what cannot
 * pile up is the text.
 */
function boxOf(node: { r: number; labelHalfWidth: number }): {
  halfW: number
  top: number
  bottom: number
} {
  return {
    halfW: Math.max(node.r, node.labelHalfWidth),
    top: node.r,
    bottom: node.r + LABEL_OFFSET + LABEL_HEIGHT,
  }
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** String hash for the seed — determinism per group. */
function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32 — small and deterministic PRNG, enough for the jitter. */
function makeRng(seed: number): () => number {
  let a = seed || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Grouping and coverage tree
// ---------------------------------------------------------------------------

/**
 * Group (tree) a memory belongs to on the canvas. Project memories go
 * to the project itself; the others, to the project where they were born — falling back to
 * the global group when there is no recorded origin.
 */
export function groupIdOf(memory: Memory): string {
  if (memory.kind === 'project' && memory.projectId) return memory.projectId
  return memory.originProjectId ?? GLOBAL_GROUP
}

function groupLabelOf(memory: Memory): string | undefined {
  if (memory.kind === 'project') return memory.projectName
  return memory.originProjectName
}

/** true when the declared relation from `parent` to `child` is hierarchical. */
function isParentEdge(parent: Memory, childId: string): boolean {
  const types = parent.relationTypes
  // Old data has no relationTypes — in that case any link serves
  // as a tree edge candidate, otherwise the legacy graph becomes only orphans.
  if (!types) return true
  return types[childId] === 'parent'
}

/**
 * Chooses the root of a group among the nodes that REALLY have a link: the overview
 * of the root scope and, without it, the most connected node. A group in which nobody
 * is linked to anybody has no root — it returns undefined, and all nodes
 * float. Without that condition, the heaviest node became an artificial hub with
 * an edge to every orphan of the group.
 */
function pickRoot(members: Memory[], connected: Set<string>): Memory | undefined {
  const candidates = members.filter((m) => connected.has(m.id))
  if (candidates.length === 0) return undefined
  const overview = candidates
    .filter((m) => m.area === 'overview' && !m.subproject)
    .sort((a, b) => b.relatedIds.length - a.relatedIds.length || a.createdAt - b.createdAt)[0]
  if (overview) return overview
  return [...candidates].sort(
    (a, b) => b.relatedIds.length - a.relatedIds.length || b.weight - a.weight || a.createdAt - b.createdAt,
  )[0]
}

interface TreeShape {
  parentOf: Map<string, string>
  childrenOf: Map<string, string[]>
  /** undefined when no node of the group has a link to another. */
  rootId?: string
  /** Nodes with no link at all — drawn loose, with no invented edge. */
  floating: string[]
}

/**
 * Extracts a coverage tree from the group subgraph. BFS from the root
 * following the declared "parent" relations first and only then the free ones —
 * so the hierarchy informed by the agent wins, and the "related" become
 * cross edges instead of distorting the tree.
 */
function spanningTree(members: Memory[]): TreeShape {
  const byId = new Map(members.map((m) => [m.id, m]))
  // "Connected" means having at least one link to another member OF THIS group —
  // relatedIds pointing outside do not count.
  const connected = new Set(
    members.filter((m) => m.relatedIds.some((rel) => rel !== m.id && byId.has(rel))).map((m) => m.id),
  )
  const root = pickRoot(members, connected)
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  if (!root) {
    return { parentOf, childrenOf, rootId: undefined, floating: members.map((m) => m.id) }
  }
  const seen = new Set<string>([root.id])

  const attach = (parentId: string, childId: string) => {
    parentOf.set(childId, parentId)
    const bucket = childrenOf.get(parentId) ?? []
    bucket.push(childId)
    childrenOf.set(parentId, bucket)
    seen.add(childId)
  }

  // Pass 1 — declared hierarchy only, layer by layer.
  let frontier = [root.id]
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) {
      const node = byId.get(id)
      if (!node) continue
      for (const rel of node.relatedIds) {
        if (seen.has(rel) || !byId.has(rel)) continue
        if (!isParentEdge(node, rel)) continue
        attach(id, rel)
        next.push(rel)
      }
    }
    frontier = next
  }

  // Pass 2 — free links pull into the tree whoever was left out.
  let progress = true
  while (progress) {
    progress = false
    for (const node of members) {
      if (!seen.has(node.id)) continue
      for (const rel of node.relatedIds) {
        if (seen.has(rel) || !byId.has(rel)) continue
        attach(node.id, rel)
        progress = true
      }
    }
  }

  // Pass 3 — whoever is left has no link at all. It stays FLOATING: hanging it
  // on the root would create an edge that does not exist and would turn the group into a
  // star around some arbitrary node.
  const floating: string[] = []
  for (const node of members) {
    if (seen.has(node.id)) continue
    floating.push(node.id)
  }

  return { parentOf, childrenOf, rootId: root.id, floating }
}

/** Descendants of collapsed nodes — the collapsed node itself stays visible. */
function hiddenDescendants(shape: TreeShape, collapsedIds: Set<string>): Set<string> {
  const hidden = new Set<string>()
  if (collapsedIds.size === 0) return hidden
  for (const id of collapsedIds) {
    const queue = [...(shape.childrenOf.get(id) ?? [])]
    while (queue.length) {
      const current = queue.pop()!
      if (hidden.has(current)) continue
      hidden.add(current)
      queue.push(...(shape.childrenOf.get(current) ?? []))
    }
  }
  return hidden
}

// ---------------------------------------------------------------------------
// Force simulation
// ---------------------------------------------------------------------------

interface SimNode extends LayoutNode {
  vx: number
  vy: number
  /** How many nodes descend from this subtree — heavy branches repel more. */
  subtreeSize: number
  /**
   * Collision box already resolved. It depends only on the radius and the label, which do not
   * change after assembly — and the separation reads this millions of times.
   */
  halfW: number
  top: number
  bottom: number
}

const ITERATIONS = 320
const ALPHA_DECAY = 0.016
/** Intensity of the repulsion between pairs — it is what opens the graph. */
const REPULSION = 3400
/** Stiffness of the parent→child springs. */
const SPRING = 0.09
/** Weak attraction to the group center, so the whole does not scatter. */
const GRAVITY = 0.012

/**
 * Seeds the positions in rings by depth, inheriting the parent angle with
 * spread and jitter. Without this seed the simulation starts from a tangle and
 * converges to something twisted; with it each branch is already born pointing to its
 * own sector, and the simulation only relaxes the drawing.
 */
function seedPositions(
  nodes: Map<string, SimNode>,
  shape: TreeShape,
  rng: () => number,
  scale = 1,
): void {
  const root = shape.rootId ? nodes.get(shape.rootId) : undefined
  if (!root) {
    scatterFloating(nodes, [...nodes.keys()], 0, rng, 0, scale)
    return
  }
  root.x = 0
  root.y = 0

  interface Slot {
    id: string
    angle: number
    spread: number
    depth: number
  }
  const queue: Slot[] = [
    { id: root.memory.id, angle: rng() * Math.PI * 2, spread: Math.PI * 2, depth: 0 },
  ]

  for (let head = 0; head < queue.length; head++) {
    const slot = queue[head]
    const children = (shape.childrenOf.get(slot.id) ?? []).filter((id) => nodes.has(id))
    if (children.length === 0) continue
    const parent = nodes.get(slot.id)!

    // The parent sector is split among the children proportionally to the size
    // of each subtree — a large branch gets more spread and does not squeeze
    // its neighbour.
    const weights = children.map((id) => Math.sqrt(nodes.get(id)!.subtreeSize))
    const total = weights.reduce((a, b) => a + b, 0) || 1
    let cursor = slot.angle - slot.spread / 2

    children.forEach((id, i) => {
      const child = nodes.get(id)!
      const share = (weights[i] / total) * slot.spread
      // Jitter inside the slice: removes the perfect fan look without letting the
      // child invade the sibling's slice.
      const angle = cursor + share * (0.3 + rng() * 0.4)
      // The distance also varies — it is what breaks the pattern of concentric rings.
      const distance =
        BASE_LINK_DISTANCE * scale * (0.8 + rng() * 0.6) * (1 + slot.depth * 0.15)
      child.x = parent.x + Math.cos(angle) * distance
      child.y = parent.y + Math.sin(angle) * distance
      // A child never gets the whole circle: at most the parent's slice, and
      // always with slack so as not to close over itself.
      queue.push({
        id,
        angle,
        spread: Math.min(share * 0.9, Math.PI * 1.2),
        depth: slot.depth + 1,
      })
      cursor += share
    })
  }

  // Floating nodes stay IN the tree band, not outside it: a general memory created
  // inside project X is knowledge of X and has to orbit the nodes of X, not
  // form a distant shell. The separation afterwards fits each one into a gap.
  const floatingSet = new Set(shape.floating)
  let treeRadius = 0
  for (const [id, node] of nodes) {
    if (floatingSet.has(id)) continue
    treeRadius = Math.max(treeRadius, Math.hypot(node.x, node.y))
  }
  scatterFloating(nodes, shape.floating, treeRadius * 0.45, rng, treeRadius * 0.75, scale)
}

/**
 * Spreads unlinked nodes over the golden angle (sunflower): θ = i × 137.5°, radius
 * proportional to √i. Fills the plane evenly without creating visible rings or spokes
 * — it is what makes the orphan cloud look natural.
 */
function scatterFloating(
  nodes: Map<string, SimNode>,
  ids: string[],
  startRadius: number,
  rng: () => number,
  /** Band where the first nodes settle before the radius grows. */
  band = 0,
  scale = 1,
): void {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  const spacing = BASE_LINK_DISTANCE * scale * 1.6
  const phase = rng() * Math.PI * 2
  ids.forEach((id, i) => {
    const node = nodes.get(id)
    if (!node) return
    const angle = phase + i * GOLDEN_ANGLE
    // √i keeps the density constant as the radius grows; the initial band
    // is drawn at random so the first nodes are already born mixed into the tree.
    const radius = startRadius + band * rng() + spacing * Math.sqrt(i) * (0.85 + rng() * 0.3)
    node.x = Math.cos(angle) * radius
    node.y = Math.sin(angle) * radius
  })
}

// ---------------------------------------------------------------------------
// Execution in slices
// ---------------------------------------------------------------------------
//
// The three heavy phases (repulsion, separation and radial tie-break) sweep all
// the pairs of the group — together, ~470 O(n²) sweeps. Running them in a single go
// holds the JS thread for seconds: nothing paints and nothing responds to
// touch, which is exactly the freeze when opening the graph.
//
// That is why each one lives in a resumable cursor: the outer loop can stop in
// the middle of a sweep and continue on the next call. The ORDER of the operations
// is the same as the single-go version — each pair keeps reading the positions
// left by the previous pairs —, so the result is identical; what changes
// is only who decides when to hand control back.

const SEPARATE_PASSES = 90
const PUSH_ROUNDS = 60

/**
 * Separation passes and tie-break rounds per group size. On the exact path each pass is O(n²) and 90 is already expensive;
 * on the grid one it is O(n · neighbors),
 * cheap enough to give much more — and that is what the saturated neighborhood of
 * a large graph needs so as not to leave label over label.
 */
function separationPassesFor(n: number): number {
  return n > GRID_MIN_SIZE ? 240 : SEPARATE_PASSES
}
function roundsFor(n: number): number {
  return n > GRID_MIN_SIZE ? 120 : PUSH_ROUNDS
}
/**
 * Pairs evaluated between two clock reads. The step has to be counted
 * in PAIRS, not in indices of the outer loop: in a group of 3 thousand nodes each outer
 * index is worth thousands of pairs, and a fixed step of 32 indices blew the
 * slice budget by more than a second. Counting pairs, the slice goes over the
 * budget by at most the cost of one block — a few milliseconds.
 */
const PAIRS_PER_CHECK = 2048

/**
 * Above this size the group swaps the all-pairs sweeps for a SPATIAL
 * GRID. Below it nothing changes: the exact path of always keeps
 * applying, and no graph that exists today changes its drawing.
 *
 * The cut is where O(n²) still fits in a blink — 250 nodes are 31 thousand pairs per
 * sweep, ~15 million in the whole pipeline.
 */
const GRID_MIN_SIZE = 250
/**
 * Radius beyond which the repulsion is disregarded on the grid path. The force falls
 * with 1/d², so from a neighborhood and a half on what is left is noise — and it is
 * what costs O(n²). The graph shape then comes from the springs, the radial seed
 * and the separation pass, which are the ones that really draw.
 */
const CUTOFF = BASE_LINK_DISTANCE * 1.5
/**
 * Gravity on the grid path. Without the far repulsion pushing outward,
 * the attraction to the center has to fall along — otherwise the group collapses into a single node and
 * everything is left for the separation to solve.
 */
const GRID_GRAVITY = 0.004
/** Average displacement per node below which the simulation has settled. */
const CONVERGED = 0.08
/**
 * Ceiling of the step of a node in one iteration.
 *
 * The repulsion grows with 1/d², so a nearly coincident pair generates an enormous
 * force — and without a ceiling it becomes a throw. In a dense group this chains: at
 * every iteration someone is thrown far away, and the whole group goes out of scale.
 * With a thousand memories in a single project, the positions reached 10²⁶ and the drawing
 * became garbage; the separation pass afterwards had nothing to save.
 *
 * The ceiling is the classic remedy of force layout (the "cooling" of
 * Fruchterman-Reingold): the direction of the force still applies, only the size of the
 * step is limited.
 *
 * It applies ONLY on the grid path. Measuring the old algorithm, group by group: up to
 * ~500 nodes it was healthy (maximum radius in the thousands) and only from
 * ~700 on did it go out of scale — and no ceiling serves both cases, because even a
 * healthy 150-node graph takes large steps in the first iterations, which the
 * drawing absorbs afterwards. Since the exact path only runs on groups of up to 250, it
 * stays without a ceiling and remains bit by bit identical to today's; the clamp comes in where
 * density really breaks.
 */
const MAX_STEP = BASE_LINK_DISTANCE * 2

/** Simulation iterations per group size — a large graph settles with
 *  fewer, and each iteration of it costs much more. */
function iterationsFor(n: number): number {
  if (n <= GRID_MIN_SIZE) return ITERATIONS
  if (n <= 1500) return 240
  return 160
}

/**
 * Uniform grid over the positions, in CSR format (one array of indices and one
 * of offsets). No array per cell: with thousands of nodes, allocating and
 * collecting thousands of arrays on every sweep would cost more than the
 * calculation itself.
 */
interface Grid {
  cell: number
  minX: number
  minY: number
  cols: number
  rows: number
  /** Starting offset of each cell in `items` (size cols*rows+1). */
  start: Int32Array
  /** Indices of the nodes, grouped by cell. */
  items: Int32Array
}

function buildGrid(list: SimNode[], minCell: number): Grid {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of list) {
    if (node.x < minX) minX = node.x
    if (node.x > maxX) maxX = node.x
    if (node.y < minY) minY = node.y
    if (node.y > maxY) maxY = node.y
  }
  const width = Math.max(1, maxX - minX)
  const height = Math.max(1, maxY - minY)
  // Cell ceiling: in a spread-out group a fine grid would spend more memory
  // than the group itself. Doubling the cell only enlarges the neighborhood swept — the
  // distance cut is still what really decides.
  let cell = minCell
  const cap = 8 * list.length + 1024
  while ((Math.ceil(width / cell) + 1) * (Math.ceil(height / cell) + 1) > cap) cell *= 2
  const cols = Math.ceil(width / cell) + 1
  const rows = Math.ceil(height / cell) + 1

  const total = cols * rows
  const start = new Int32Array(total + 1)
  const cellOf = new Int32Array(list.length)
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    const c = Math.min(cols - 1, Math.max(0, Math.floor((node.x - minX) / cell)))
    const l = Math.min(rows - 1, Math.max(0, Math.floor((node.y - minY) / cell)))
    const cel = l * cols + c
    cellOf[i] = cel
    start[cel + 1]++
  }
  for (let cel = 0; cel < total; cel++) start[cel + 1] += start[cel]
  const items = new Int32Array(list.length)
  const cursor = start.slice(0, total)
  for (let i = 0; i < list.length; i++) items[cursor[cellOf[i]]++] = i
  return { cell, minX, minY, cols, rows, start, items }
}

/** Indices of the nodes in the 9 cells around `i`, written into `buffer`. */
function neighborsOf(grid: Grid, list: SimNode[], i: number, buffer: Int32Array): number {
  const node = list[i]
  const c = Math.min(grid.cols - 1, Math.max(0, Math.floor((node.x - grid.minX) / grid.cell)))
  const l = Math.min(grid.rows - 1, Math.max(0, Math.floor((node.y - grid.minY) / grid.cell)))
  const c0 = c > 0 ? c - 1 : 0
  const c1 = c + 1 < grid.cols ? c + 1 : grid.cols - 1
  const l0 = l > 0 ? l - 1 : 0
  const l1 = l + 1 < grid.rows ? l + 1 : grid.rows - 1
  let count = 0
  for (let ll = l0; ll <= l1; ll++) {
    const base = ll * grid.cols
    for (let cc = c0; cc <= c1; cc++) {
      const cel = base + cc
      const end = grid.start[cel + 1]
      for (let p = grid.start[cel]; p < end; p++) buffer[count++] = grid.items[p]
    }
  }
  return count
}

/** Cell side that guarantees finding every box able to pile up with another. */
function separationCellSize(list: SimNode[]): number {
  let maxHalfW = 0
  let maxTop = 0
  let maxBottom = 0
  for (const node of list) {
    const box = boxOf(node)
    if (box.halfW > maxHalfW) maxHalfW = box.halfW
    if (box.top > maxTop) maxTop = box.top
    if (box.bottom > maxBottom) maxBottom = box.bottom
  }
  // The 1.5 slack covers how far a node moves WITHIN a sweep: the grid
  // is built at its start and the positions change while it runs.
  return Math.max(2 * maxHalfW + MIN_GAP, maxTop + maxBottom + MIN_GAP) * 1.5
}

const clock: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

interface SimLink {
  a: SimNode
  b: SimNode
  rest: number
}

type GroupPhase = 'simulation' | 'separation' | 'push' | 'done'

interface SimGroup {
  id: string
  list: SimNode[]
  links: SimLink[]
  phase: GroupPhase
  /** Large group: grid sweeps instead of all pairs. */
  usesGrid: boolean
  /** Simulation iterations — fewer in large groups. */
  iterations: number
  /** Separation passes and tie-break rounds of this group. */
  passes: number
  rounds: number
  /** Grid of the sweep in progress, rebuilt on every round. */
  grid: Grid | null
  /** Cell side used in the separation phases. */
  separationCell: number
  /**
   * Scale of the group. The natural parent-child distance (90) is SMALLER than the
   * width of a label box (up to 190): in a large group the simulation
   * delivers a tangle, and the separation receives hundreds of neighbors per node
   * to undo on its own. Stretching springs, seed and repulsion reach by the
   * average box size makes the simulation already deliver the right spacing —
   * it is the difference between the grid being worth it and not.
   */
  scale: number
  /** Repulsion reach squared and force, scaled along. */
  cutoff2: number
  repulsion: number
  /** Neighbor scratch buffer — one per group, reused on every query. */
  buffer: Int32Array
  /** Displacement summed in the iteration in progress, to detect convergence. */
  movement: number
  /** Cooling of the simulation — survives across slices. */
  alpha: number
  /** Iteration (sim), pass (sep) or round (push) in progress. */
  turn: number
  /** Index of the outer loop where the sweep stopped. */
  cursor: number
  /** Did anyone move in the sweep in progress? When nobody moves, the phase
   *  ends before the limit — it is the `break` of the single-go versions. */
  active: boolean
}

/**
 * Unit of progress: one node swept. It serves both paths — inside a
 * group the cost per node is uniform, so the bar moves linearly.
 */
function sweepsFor(n: number): number {
  return iterationsFor(n) + separationPassesFor(n) + roundsFor(n)
}

/**
 * Penetration of the boxes of a and b on both axes (including the minimum slack), or
 * null when they do not touch.
 *
 * The return object is REUSED: the separation calls this millions of times
 * and allocating three objects per call — the two boxes and the result — was the
 * most expensive calculation of the phase. Callers read the two fields right away and do not keep the
 * reference.
 */
const penetration = { x: 0, y: 0 }
function overlapOf(a: SimNode, b: SimNode): { x: number; y: number } | null {
  const x = a.halfW + b.halfW + MIN_GAP - Math.abs(b.x - a.x)
  if (x <= 0) return null
  // Asymmetric vertical: the box goes down more than up (the label sits below
  // the circle), so the test depends on who is on top.
  const dy = b.y - a.y
  const y = dy >= 0 ? a.bottom + b.top + MIN_GAP - dy : b.bottom + a.top + MIN_GAP + dy
  if (y <= 0) return null
  penetration.x = x
  penetration.y = y
  return penetration
}

// ---------------------------------------------------------------------------
// Canvas assembly
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Ids with the collapsed subtree. */
  collapsedIds?: Set<string>
  /** Draws edges inferred from tags (always within the same group). */
  inferEdges?: boolean
  /**
   * Label actually drawn, when the platform translates the text (the
   * areas appear in the UI language). It only affects the width used in the collision.
   */
  labelOf?: (memory: Memory, isRoot: boolean) => string
}

/**
 * Layout in progress — the same work as `layoutMemoryGraph`, only
 * delivered in slices to whoever cannot block the thread.
 */
export interface MemoryGraphJob {
  /** Works for up to `budgetMs` and returns `true` when finished. With
   *  `Infinity` it runs everything in a single call. */
  step(budgetMs: number): boolean
  readonly done: boolean
  /** 0..1, monotonic — feeds the progress bar. */
  readonly progress: number
  /**
   * Layout with the CURRENT positions. While `done` is false it is partial: it is
   * what allows showing the graph settling instead of an opaque spinner.
   */
  snapshot(): MemoryLayout
}

/**
 * Assembles the whole canvas: one organic graph per project, packed side by
 * side without touching — in slices, to fit between two frames.
 */
export function createMemoryGraphJob(
  pool: Memory[],
  options: LayoutOptions = {},
): MemoryGraphJob {
  const collapsedIds = options.collapsedIds ?? new Set<string>()
  const labelOf = options.labelOf ?? nodeLabelText

  const byGroup = new Map<string, Memory[]>()
  const labels = new Map<string, string>()
  for (const memory of pool) {
    const gid = groupIdOf(memory)
    const bucket = byGroup.get(gid) ?? []
    bucket.push(memory)
    byGroup.set(gid, bucket)
    const label = groupLabelOf(memory)
    if (label && !labels.has(gid)) labels.set(gid, label)
  }

  // Larger projects first; the global group closes the list.
  const groupIds = [...byGroup.keys()].sort((a, b) => {
    if (a === GLOBAL_GROUP) return 1
    if (b === GLOBAL_GROUP) return -1
    return byGroup.get(b)!.length - byGroup.get(a)!.length
  })

  const simGroups: SimGroup[] = []
  const treeEdges: LayoutEdge[] = []

  // Progress is dominated by the pair sweeps, so the weight of each
  // group is the number of pairs times the sweeps it still has to take. The
  // preparation is out of the count: next to that it is noise.
  let totalUnits = 0
  for (const gid of groupIds) {
    const n = byGroup.get(gid)!.length
    totalUnits += n * sweepsFor(n)
  }
  totalUnits = Math.max(1, totalUnits)
  let units = 0

  let phase: 'prep' | 'groups' | 'done' = 'prep'
  let prepIdx = 0
  let simGroupIdx = 0

  /** Tree, seed and springs of a group — everything the simulation needs. */
  function prepareGroup(gid: string): SimGroup | null {
    const members = byGroup.get(gid)!
    const shape = spanningTree(members)
    const hidden = hiddenDescendants(shape, collapsedIds)
    const floatingIds = new Set(shape.floating)

    // Depth and subtree size — they feed the seeding and the repulsion.
    // Without a root (fully disconnected group) there is no traversal: everyone
    // floats and gets the default depth right below.
    const depth = new Map<string, number>(shape.rootId ? [[shape.rootId, 0]] : [])
    const order: string[] = shape.rootId ? [shape.rootId] : []
    for (let i = 0; i < order.length; i++) {
      const id = order[i]
      for (const child of shape.childrenOf.get(id) ?? []) {
        depth.set(child, depth.get(id)! + 1)
        order.push(child)
      }
    }
    const subtreeSize = new Map<string, number>()
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]
      let size = 1
      for (const child of shape.childrenOf.get(id) ?? []) size += subtreeSize.get(child) ?? 1
      subtreeSize.set(id, size)
    }

    const nodes = new Map<string, SimNode>()
    for (const memory of members) {
      if (hidden.has(memory.id)) continue
      const isRoot = memory.id === shape.rootId
      const children = shape.childrenOf.get(memory.id) ?? []
      const radius = nodeRadius(memory, isRoot)
      const halfLabelWidth = labelHalfWidthOf(labelOf(memory, isRoot))
      nodes.set(memory.id, {
        memory,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        depth: depth.get(memory.id) ?? 0,
        isRoot,
        floating: floatingIds.has(memory.id),
        parentId: shape.parentOf.get(memory.id),
        childCount: children.length,
        collapsed: collapsedIds.has(memory.id),
        groupId: gid,
        r: radius,
        labelHalfWidth: halfLabelWidth,
        subtreeSize: subtreeSize.get(memory.id) ?? 1,
        halfW: Math.max(radius, halfLabelWidth),
        top: radius,
        bottom: radius + LABEL_OFFSET + LABEL_HEIGHT,
      })
    }
    if (nodes.size === 0) return null

    const list = [...nodes.values()]
    const usesGrid = list.length > GRID_MIN_SIZE
    // Average box of the group (full width + slack) against the natural distance
    // of an edge: the quotient is how much the group needs to stretch.
    let halfWSum = 0
    for (const node of list) halfWSum += node.halfW
    const averageBox = (2 * halfWSum) / list.length + MIN_GAP
    const scale = usesGrid ? Math.max(1, averageBox / BASE_LINK_DISTANCE) : 1

    seedPositions(nodes, shape, makeRng(seedOf(gid)), scale)

    const links: SimLink[] = []
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined
      if (!parent) continue
      // A parent with many children needs a larger radius for all to fit around.
      const siblings = parent.childCount || 1
      const rest =
        BASE_LINK_DISTANCE *
        (0.85 + Math.sqrt(siblings) * 0.22) *
        (1 + Math.min(node.depth, 5) * 0.06)
      links.push({ a: parent, b: node, rest: rest * scale })
      treeEdges.push({
        from: parent.memory.id,
        to: node.memory.id,
        kind: 'tree',
        hits: parent.memory.hits + node.memory.hits,
      })
    }

    return {
      id: gid,
      list: list,
      links,
      phase: 'simulation',
      usesGrid,
      iterations: iterationsFor(list.length),
      passes: separationPassesFor(list.length),
      rounds: roundsFor(list.length),
      grid: null,
      separationCell: separationCellSize(list),
      scale,
      // The force grows with the square of the distance so the balance between
      // spring and repulsion lands at the same point, only on the new scale.
      cutoff2: (CUTOFF * scale) ** 2,
      repulsion: REPULSION * scale * scale,
      buffer: new Int32Array(list.length),
      movement: 0,
      alpha: 1,
      turn: 0,
      cursor: 0,
      active: false,
    }
  }

  /**
   * Repulsion of `i` against all following pairs — the exact path, with the
   * push applied to both nodes at once. Returns the pairs evaluated.
   */
  function repulsionExact(list: SimNode[], i: number): number {
    const n = list.length
    const a = list[i]
    for (let j = i + 1; j < n; j++) {
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        // Coincident: tie-break with a deterministic push.
        dx = (i % 7) - 3 + 0.5
        dy = (j % 7) - 3 + 0.5
        d2 = dx * dx + dy * dy
      }
      // Nodes of larger branches push harder, opening room for them.
      const strength =
        (REPULSION * (1 + Math.log2(1 + a.subtreeSize + b.subtreeSize) * 0.35)) / d2
      const d = Math.sqrt(d2)
      const fx = (dx / d) * strength
      const fy = (dy / d) * strength
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
    return n - 1 - i
  }

  /**
   * Repulsion of `i` against the grid neighborhood — only what is inside the
   * cut. Here the force is applied ONLY to `i`: each pair ends up evaluated twice,
   * once from each side, and the sum of the forces is the same as on the exact path.
   */
  function repulsionNeighbor(g: SimGroup, i: number): number {
    const { list, buffer } = g
    const a = list[i]
    const count = neighborsOf(g.grid!, list, i, buffer)
    for (let p = 0; p < count; p++) {
      const j = buffer[p]
      if (j === i) continue
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 > g.cutoff2) continue
      if (d2 < 1) {
        // Coincident: same tie-break as the exact path, oriented from the
        // smaller pair to the larger, so both sides push in opposite
        // opposite directions instead of the same one.
        const lo = i < j ? i : j
        const hi = i < j ? j : i
        dx = (lo % 7) - 3 + 0.5
        dy = (hi % 7) - 3 + 0.5
        if (i !== lo) {
          dx = -dx
          dy = -dy
        }
        d2 = dx * dx + dy * dy
      }
      const strength =
        (g.repulsion * (1 + Math.log2(1 + a.subtreeSize + b.subtreeSize) * 0.35)) / d2
      const d = Math.sqrt(d2)
      a.vx -= (dx / d) * strength
      a.vy -= (dy / d) * strength
    }
    return count
  }

  /** Springs + repulsion + gravity, with progressive cooling. */
  function simulate(g: SimGroup, overBudget: () => boolean): boolean {
    const { list, links } = g
    const n = list.length
    const gravity = g.usesGrid ? GRID_GRAVITY : GRAVITY
    while (g.turn < g.iterations) {
      // The grid is worth one iteration: in the next one the positions are already different.
      // Building it costs O(n), against the O(n · neighbors) of the sweep.
      if (g.usesGrid && g.cursor === 0) {
        g.grid = buildGrid(list, CUTOFF * g.scale)
        g.movement = 0
      }
      // Repulsion — the outer loop is the resume point.
      while (g.cursor < n) {
        let remaining = PAIRS_PER_CHECK
        while (g.cursor < n && remaining > 0) {
          const i = g.cursor++
          remaining -= g.usesGrid ? repulsionNeighbor(g, i) : repulsionExact(list, i)
          units++
        }
        if (overBudget()) return false
      }

      for (const link of links) {
        const dx = link.b.x - link.a.x
        const dy = link.b.y - link.a.y
        const d = Math.hypot(dx, dy) || 0.01
        const force = SPRING * (d - link.rest)
        const fx = (dx / d) * force
        const fy = (dy / d) * force
        link.a.vx += fx
        link.a.vy += fy
        link.b.vx -= fx
        link.b.vy -= fy
      }

      for (const node of list) {
        if (node.isRoot) {
          // The root stays pinned at the center: it is the visual anchor of the group.
          node.vx = 0
          node.vy = 0
          node.x = 0
          node.y = 0
          continue
        }
        node.vx -= node.x * gravity
        node.vy -= node.y * gravity
        let px = node.vx * g.alpha
        let py = node.vy * g.alpha
        if (g.usesGrid) {
          const step = Math.hypot(px, py)
          const cap = MAX_STEP * g.scale
          if (step > cap) {
            // Cuts the step AND the velocity: only shortening the step would leave the
            // energy stored in the velocity to blow up in the next iteration.
            const brake = cap / step
            px *= brake
            py *= brake
            node.vx *= brake
            node.vy *= brake
          }
        }
        node.x += px
        node.y += py
        if (g.usesGrid) g.movement += Math.abs(px) + Math.abs(py)
        // Damping: without it the system oscillates instead of settling.
        node.vx *= 0.6
        node.vy *= 0.6
      }

      g.alpha *= 1 - ALPHA_DECAY
      g.turn++
      g.cursor = 0
      // Settled: the remaining iterations no longer change the drawing, and in a
      // large group each of them is expensive.
      // The threshold follows the scale of the group: in a stretched group, "stopped" is
      // proportionally larger in world units.
      if (g.usesGrid && g.movement / n < CONVERGED * g.scale) {
        units += (g.iterations - g.turn) * n
        return true
      }
      if (overBudget()) return false
    }
    return true
  }

  /**
   * Separation pass — the hard rule of minimum space. Resolves overlap of the
   * LABEL BOXES by pushing the pair along the axis of least penetration, which is
   * the minimum displacement able to open the slack.
   */
  function separate(g: SimGroup, overBudget: () => boolean): boolean {
    const { list, buffer } = g
    const n = list.length
    while (g.turn < g.passes) {
      if (g.usesGrid && g.cursor === 0) g.grid = buildGrid(list, g.separationCell)
      while (g.cursor < n) {
        let remaining = PAIRS_PER_CHECK
        while (g.cursor < n && remaining > 0) {
          const i = g.cursor++
          const a = list[i]
          // On the grid only the 9 cells around it come in; on the exact path, all
          // following indices. In both cases each pair is handled only once
          // and in the same order.
          const count = g.usesGrid ? neighborsOf(g.grid!, list, i, buffer) : n
          for (let p = g.usesGrid ? 0 : i + 1; p < count; p++) {
            const j = g.usesGrid ? buffer[p] : p
            if (j <= i) continue
            const b = list[j]
            const overlap = overlapOf(a, b)
            if (!overlap) continue
            g.active = true
            if (overlap.x < overlap.y) {
              const dir = b.x >= a.x ? 1 : -1
              const push = (overlap.x / 2) * dir
              if (!a.isRoot) a.x -= push
              if (!b.isRoot) b.x += push
            } else {
              const dir = b.y >= a.y ? 1 : -1
              const push = (overlap.y / 2) * dir
              if (!a.isRoot) a.y -= push
              if (!b.isRoot) b.y += push
            }
          }
          remaining -= count
          units++
        }
        if (overBudget()) return false
      }
      const moved = g.active
      g.active = false
      g.cursor = 0
      g.turn++
      if (!moved) {
        // Settled before the limit: what is left of the phase enters the progress
        // at once, otherwise the bar would stay stuck waiting for work that is not
        // is going to happen.
        units += (g.passes - g.turn) * n
        return true
      }
      if (overBudget()) return false
    }
    return true
  }

  /**
   * Safety net: if after the separation there is still a piled-up box
   * (saturated neighborhood), pushes the deepest node radially outward until
   * opening room. It is the literal "go one level farther".
   */
  function pushApart(g: SimGroup, overBudget: () => boolean): boolean {
    const { list, buffer } = g
    const n = list.length
    while (g.turn < g.rounds) {
      if (g.usesGrid && g.cursor === 0) g.grid = buildGrid(list, g.separationCell)
      while (g.cursor < n) {
        let remaining = PAIRS_PER_CHECK
        while (g.cursor < n && remaining > 0) {
          const i = g.cursor++
          const a = list[i]
          const count = g.usesGrid ? neighborsOf(g.grid!, list, i, buffer) : n
          for (let p = g.usesGrid ? 0 : i + 1; p < count; p++) {
            const j = g.usesGrid ? buffer[p] : p
            if (j <= i) continue
            const b = list[j]
            const overlap = overlapOf(a, b)
            if (!overlap) continue
            g.active = true
            // The one with fewer links gives way: floating before whoever is in the
            // tree and, between two from the tree, the deepest. The root never
            // move.
            const rank = (node: SimNode) => (node.isRoot ? -1 : node.floating ? 1e6 : node.depth)
            const victim = a.isRoot ? b : b.isRoot ? a : rank(a) >= rank(b) ? a : b
            const dist = Math.hypot(victim.x, victim.y) || 0.01
            const step = Math.max(overlap.x, overlap.y) + MIN_GAP
            victim.x += (victim.x / dist) * step
            victim.y += (victim.y / dist) * step
          }
          remaining -= count
          units++
        }
        if (overBudget()) return false
      }
      const collided = g.active
      g.active = false
      g.cursor = 0
      g.turn++
      if (!collided) {
        units += (g.rounds - g.turn) * n
        return true
      }
      if (overBudget()) return false
    }
    return true
  }

  /** Advances a group through its three phases; false when the budget ran out. */
  function advanceGroup(g: SimGroup, overBudget: () => boolean): boolean {
    if (g.phase === 'simulation') {
      if (!simulate(g, overBudget)) return false
      g.phase = 'separation'
      g.turn = 0
      g.cursor = 0
      g.active = false
    }
    if (g.phase === 'separation') {
      if (!separate(g, overBudget)) return false
      g.phase = 'push'
      g.turn = 0
      g.cursor = 0
      g.active = false
    }
    if (g.phase === 'push') {
      if (!pushApart(g, overBudget)) return false
      g.phase = 'done'
    }
    return true
  }

  /**
   * Spreading of the groups + assembly of the result. Packing in rows produced
   * visible rows of projects side by side; the golden-angle spiral
   * spreads the islands with no perceptible alignment, and the separation guarantees that
   * two never touch.
   *
   * It runs from the current positions, so it serves both the final result
   * and the mid-way previews.
   */
  function assemble(): MemoryLayout {
    const nodes: LayoutNode[] = []
    const groups: LayoutGroup[] = []

    interface Island {
      simGroup: SimGroup
      minX: number
      minY: number
      maxX: number
      maxY: number
      cx: number
      cy: number
      radius: number
    }
    // Radius of the circle around the group — half the diagonal of its box.
    const islands: Island[] = simGroups.map((simGroup) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const node of simGroup.list) {
        const box = boxOf(node)
        minX = Math.min(minX, node.x - box.halfW)
        maxX = Math.max(maxX, node.x + box.halfW)
        minY = Math.min(minY, node.y - box.top)
        maxY = Math.max(maxY, node.y + box.bottom)
      }
      return {
        simGroup,
        minX,
        minY,
        maxX,
        maxY,
        cx: 0,
        cy: 0,
        radius: Math.hypot(maxX - minX, maxY - minY) / 2,
      }
    })
    // Larger first so they take the middle; the id breaks ties so the result
    // does not depend on the Map iteration order.
    islands.sort((a, b) => b.radius - a.radius || a.simGroup.id.localeCompare(b.simGroup.id))

    const groupRng = makeRng(seedOf('memory-graph-islands'))
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
    let reach = 0
    islands.forEach((island, i) => {
      if (i === 0) return
      // The radius accumulates the size of the islands already placed, so large groups
      // push the following ones away instead of being run over by them.
      reach += island.radius * 0.85
      const angle = i * GOLDEN_ANGLE + groupRng() * 0.4
      island.cx = Math.cos(angle) * reach
      island.cy = Math.sin(angle) * reach
    })

    for (let pass = 0; pass < 240; pass++) {
      let moved = false
      for (let i = 0; i < islands.length; i++) {
        for (let j = i + 1; j < islands.length; j++) {
          const a = islands[i]
          const b = islands[j]
          const dx = b.cx - a.cx
          const dy = b.cy - a.cy
          const distance = Math.hypot(dx, dy) || 0.01
          const needed = a.radius + b.radius + GROUP_GAP
          if (distance >= needed) continue
          moved = true
          const push = (needed - distance) / 2
          const ux = dx / distance
          const uy = dy / distance
          a.cx -= ux * push
          a.cy -= uy * push
          b.cx += ux * push
          b.cy += uy * push
        }
      }
      if (!moved) break
    }

    for (const island of islands) {
      // Shifts by the CENTER of the box, not by the corner — it is the center the spiral
      // positioned it.
      const dx = island.cx - (island.minX + island.maxX) / 2
      const dy = island.cy - (island.minY + island.maxY) / 2
      for (const node of island.simGroup.list) {
        nodes.push({
          memory: node.memory,
          x: node.x + dx,
          y: node.y + dy,
          depth: node.depth,
          isRoot: node.isRoot,
          floating: node.floating,
          parentId: node.parentId,
          childCount: node.childCount,
          collapsed: node.collapsed,
          groupId: node.groupId,
          r: node.r,
          labelHalfWidth: node.labelHalfWidth,
        })
      }
      groups.push({
        id: island.simGroup.id,
        label: labels.get(island.simGroup.id) ?? '',
        minX: island.minX + dx,
        minY: island.minY + dy,
        maxX: island.maxX + dx,
        maxY: island.maxY + dy,
      })
    }

    const visibleById = new Map(nodes.map((n) => [n.memory.id, n]))
    const edges: LayoutEdge[] = treeEdges.filter(
      (e) => visibleById.has(e.from) && visibleById.has(e.to),
    )
    const seen = new Set(edges.map((e) => [e.from, e.to].sort().join(':')))

    // Real relations the tree did not absorb (second parent, "related").
    for (const node of nodes) {
      for (const rel of node.memory.relatedIds) {
        const other = visibleById.get(rel)
        if (!other) continue
        // Linking between groups is always noise: distinct projects do not cross.
        if (other.groupId !== node.groupId) continue
        const key = [node.memory.id, rel].sort().join(':')
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          from: node.memory.id,
          to: rel,
          kind: 'cross',
          hits: node.memory.hits + other.memory.hits,
        })
      }
    }

    if (options.inferEdges) {
      const tagIndex = new Map<string, string[]>()
      for (const node of nodes) {
        for (const tag of node.memory.tags) {
          const key = `${node.groupId}::${normalizeText(tag)}`
          const bucket = tagIndex.get(key) ?? []
          bucket.push(node.memory.id)
          tagIndex.set(key, bucket)
        }
      }
      let count = 0
      const compared = new Set<string>()
      for (const node of nodes) {
        if (count >= MAX_INFERRED_EDGES) break
        const candidates = new Set<string>()
        for (const tag of node.memory.tags) {
          for (const id of tagIndex.get(`${node.groupId}::${normalizeText(tag)}`) ?? []) {
            if (id !== node.memory.id) candidates.add(id)
          }
        }
        for (const candidateId of candidates) {
          if (count >= MAX_INFERRED_EDGES) break
          const key = [node.memory.id, candidateId].sort().join(':')
          if (seen.has(key) || compared.has(key)) continue
          compared.add(key)
          const other = visibleById.get(candidateId)?.memory
          if (!other || other.tags.length === 0) continue
          if (jaccard(node.memory.tags, other.tags) >= INFERRED_JACCARD) {
            seen.add(key)
            edges.push({ from: node.memory.id, to: candidateId, kind: 'inferred', hits: 0 })
            count++
          }
        }
      }
    }

    return { nodes, edges, groups }
  }

  function step(budgetMs: number): boolean {
    if (phase === 'done') return true
    const start = clock()
    const overBudget = () => clock() - start >= budgetMs

    for (;;) {
      if (phase === 'prep') {
        while (prepIdx < groupIds.length) {
          const simGroup = prepareGroup(groupIds[prepIdx++])
          if (simGroup) simGroups.push(simGroup)
          if (overBudget()) return false
        }
        phase = 'groups'
        simGroupIdx = 0
        continue
      }
      if (simGroupIdx >= simGroups.length) {
        phase = 'done'
        return true
      }
      if (!advanceGroup(simGroups[simGroupIdx], overBudget)) return false
      simGroupIdx++
    }
  }

  return {
    step,
    get done() {
      return phase === 'done'
    },
    get progress() {
      return phase === 'done' ? 1 : Math.min(0.999, units / totalUnits)
    },
    snapshot: assemble,
  }
}

/**
 * Full layout in one call — the synchronous form, for whoever can block
 * (the desktop, the tests). On mobile use `createMemoryGraphJob`.
 */
export function layoutMemoryGraph(pool: Memory[], options: LayoutOptions = {}): MemoryLayout {
  const job = createMemoryGraphJob(pool, options)
  // With an infinite budget the step never hands control back midway; the loop is
  // only a safety net.
  while (!job.step(Infinity)) {
    /* empty */
  }
  return job.snapshot()
}

/**
 * Visibility rule of the project filter — used by both platforms.
 *
 * Selecting a project shows ONLY what belongs to it: the project memories
 * and the general ones that were born there. General memories of other projects (or without a
 * recorded origin, as with those created before this field existed) stay out
 * — they polluted every project view without having a relation to any. To see them
 * one only has to set the selector back to "all projects".
 *
 * This is a DISPLAY filter only: the context injected into the prompt keeps
 * loading the general preferences in any project (loadPromptContext).
 */
export function matchesProjectFilter(memory: Memory, projectId: string): boolean {
  if (memory.kind === 'project') return memory.projectId === projectId
  return memory.originProjectId === projectId
}
