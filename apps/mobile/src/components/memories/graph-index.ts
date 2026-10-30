/**
 * Drawing index of the graph — what the scene needs per node, computed ONCE
 * per layout, and the spatial blocks that allow mounting only the visible piece.
 *
 * Before, every render of the scene redid, per node: `normalizeText` over the whole
 * text of the memory to know whether it matched the search, the label truncation, the
 * "recent/forgotten" calculation and the collision box. With thousands of nodes that
 * was work proportional to the WHOLE graph on every viewport change.
 *
 * The blocks are left over from when the scene was mounted in SVG and had to be
 * clipped by viewport. With the drawing in Skia — the whole scene recorded into a
 * SkPicture and only transformed per frame — they no longer decide what is
 * drawn; they serve the SUMMARY of the far zoom, where each block becomes a dot
 * with a size proportional to how many memories it represents.
 */
import type { Memory, MemoryLayout, LayoutNode } from '@orbit/shared'
import { LABEL_HEIGHT, LABEL_OFFSET, nodeLabelText, normalizeText } from '@orbit/shared'
import { KIND_COLOR, lastActivity } from './meta'

const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
/** Nodes per block. Too few and the block list becomes the cost; too many and the
 *  block stops being a small piece. */
const NODES_PER_BLOCK = 48
/** Gray of the edges that are not of a relation. */
const EDGE_GRAY = '#8a8e99'

export interface Region {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface NodeShape {
  id: string
  x: number
  y: number
  r: number
  color: string
  fillOpacity: number
  strokeWidth: number
  label: string
  labelY: number
  fontSize: number
  fontWeight: '400' | '600' | '700'
  isRoot: boolean
  /** Root or area: the landmarks that stay drawn at the far zoom. */
  landmark: boolean
  recent: boolean
  stale: boolean
  /** Occupied box (circle + label), already resolved. */
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface EdgeShape {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  opacity: number
  width: number
  dash?: string
  tree: boolean
}

/**
 * Block of NODES. The box covers only the circles and labels, without the edges: a
 * long edge would stretch the box across half the canvas and the block would enter the scene on
 * every drag, which is the opposite of what the blocks exist for.
 */
export interface NodeBlock {
  key: string
  minX: number
  maxX: number
  minY: number
  maxY: number
  nodes: NodeShape[]
  /** Summary of the block for the far zoom: a dot at the center of mass. */
  cx: number
  cy: number
  radius: number
  color: string
}

export interface GraphIndex {
  blocks: NodeBlock[]
  /** All the nodes, in drawing order. */
  nodes: NodeShape[]
  edges: EdgeShape[]
  /** Roots and areas — drawn at any zoom level. */
  landmarks: NodeShape[]
  bounds: Region
  total: number
}

const EMPTY_INDEX: GraphIndex = {
  blocks: [],
  nodes: [],
  edges: [],
  landmarks: [],
  bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  total: 0,
}

function toNodeShape(node: LayoutNode, now: number): NodeShape {
  const { memory } = node
  const activity = lastActivity(memory)
  const color = KIND_COLOR[memory.kind]
  const label = nodeLabelText(memory, node.isRoot)
  const halfW = Math.max(node.r, node.labelHalfWidth)
  return {
    id: memory.id,
    x: node.x,
    y: node.y,
    r: node.r,
    color,
    fillOpacity: node.isRoot ? 0.3 : memory.area ? 0.16 : 0.24,
    strokeWidth: node.isRoot ? 2 : 1.2,
    label,
    labelY: node.r + LABEL_OFFSET + 10,
    fontSize: node.isRoot ? 13 : memory.area ? 11 : 10,
    fontWeight: node.isRoot ? '700' : memory.area ? '600' : '400',
    isRoot: node.isRoot,
    landmark: node.isRoot || memory.area != null,
    recent: now - activity < RECENT_MS,
    stale: now - activity > STALE_MS,
    minX: node.x - halfW,
    maxX: node.x + halfW,
    minY: node.y - node.r,
    maxY: node.y + node.r + LABEL_OFFSET + LABEL_HEIGHT,
  }
}

export function buildGraphIndex(
  layout: MemoryLayout | null,
  now: number,
  primaryColor: string,
): GraphIndex {
  if (!layout || layout.nodes.length === 0) return EMPTY_INDEX

  const nodes = layout.nodes.map((node) => toNodeShape(node, now))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const landmarks = nodes.filter((n) => n.landmark)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    if (node.minX < minX) minX = node.minX
    if (node.maxX > maxX) maxX = node.maxX
    if (node.minY < minY) minY = node.minY
    if (node.maxY > maxY) maxY = node.maxY
  }

  // Block side computed from the real density: the graph may occupy
  // three hundred or three hundred thousand world points, and a fixed side would be good in one
  // case and terrible in the other.
  const area = Math.max(1, (maxX - minX) * (maxY - minY))
  const side = Math.max(1, Math.sqrt((area / nodes.length) * NODES_PER_BLOCK))
  const columns = Math.max(1, Math.ceil((maxX - minX) / side) + 1)

  const blocksByKey = new Map<number, NodeBlock>()
  const cellIndex = (x: number, y: number) =>
    Math.floor((y - minY) / side) * columns + Math.floor((x - minX) / side)

  for (const node of nodes) {
    const key = cellIndex(node.x, node.y)
    let b = blocksByKey.get(key)
    if (!b) {
      b = {
        key: `n${key}`,
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        nodes: [],
        cx: 0,
        cy: 0,
        radius: 0,
        color: '',
      }
      blocksByKey.set(key, b)
    }
    b.nodes.push(node)
    if (node.minX < b.minX) b.minX = node.minX
    if (node.maxX > b.maxX) b.maxX = node.maxX
    if (node.minY < b.minY) b.minY = node.minY
    if (node.maxY > b.maxY) b.maxY = node.maxY
  }

  const edges: EdgeShape[] = []
  for (const edge of layout.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b) continue
    const tree = edge.kind === 'tree'
    // Color and opacity SEPARATED: in Skia the paint receives the color and then the
    // alpha, so an `rgba(...)` with transparency built in would be erased by the
    // `setAlphaf` that comes next.
    const edgeShape: EdgeShape = {
      key: `${edge.from}:${edge.to}`,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      color: tree || edge.kind === 'inferred' ? EDGE_GRAY : primaryColor,
      opacity: tree ? 0.45 : edge.kind === 'inferred' ? 0.2 : 0.3,
      width: tree ? 1 + Math.min(edge.hits / 14, 1.4) : 1,
      dash: tree ? undefined : edge.kind === 'inferred' ? '3 5' : '6 4',
      tree,
    }
    edges.push(edgeShape)
  }

  const list = [...blocksByKey.values()]
  for (const b of list) {
    let sumX = 0
    let sumY = 0
    const counts = new Map<string, number>()
    for (const node of b.nodes) {
      sumX += node.x
      sumY += node.y
      counts.set(node.color, (counts.get(node.color) ?? 0) + 1)
    }
    const total = Math.max(1, b.nodes.length)
    b.cx = sumX / total
    b.cy = sumY / total
    // Radius of the summary grows with the square root of the count: that is how the area of the
    // dot becomes proportional to how many memories it represents.
    b.radius = Math.min(side / 2, 6 + Math.sqrt(b.nodes.length) * 3)
    let best = ''
    let bestCount = -1
    for (const [color, count] of counts) {
      if (count > bestCount) {
        bestCount = count
        best = color
      }
    }
    b.color = best || KIND_COLOR.general
  }

  return {
    blocks: list,
    nodes,
    edges,
    landmarks,
    bounds: { minX, maxX, minY, maxY },
    total: nodes.length,
  }
}

/** Ids of the memories that match the search. `null` = empty search (all match). */
export function matchingIds(pool: Memory[], query: string): Set<string> | null {
  const tokens = normalizeText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return null
  const matches = new Set<string>()
  for (const memory of pool) {
    const target = normalizeText(`${memory.text} ${memory.tags.join(' ')}`)
    if (tokens.every((tok) => target.includes(tok))) matches.add(memory.id)
  }
  return matches
}
