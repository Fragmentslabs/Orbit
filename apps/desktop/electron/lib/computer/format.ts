import { globalToShot, visibleIn, type ShotGeometry } from './geometry'
import type { ElementHandle } from './registry'
import type { AxNode, Frame, TreeSnapshot } from './types'

/**
 * Árvore AX → texto indentado com um índice por linha. É o contrato com o
 * modelo: cada linha diz o que o elemento é, o que dá para fazer com ele e
 * onde ele está NA IMAGEM (o frame vai no espaço do screenshot, o mesmo das
 * coordenadas x/y). Grupos sem nada a dizer não ganham linha — os filhos sobem
 * de nível —, porque a árvore do AX é cheia de caixas vazias que só gastam token.
 */

const TRANSPARENT_ROLES = new Set(['AXGroup', 'AXUnknown', 'AXLayoutArea', 'AXSplitGroup', 'AXLayoutItem'])
const QUIET_ACTIONS = new Set(['AXScrollToVisible', 'AXShowDefaultUI', 'AXShowAlternateUI'])

/** Subpapéis que não dizem nada além do papel. */
const PLAIN_SUBROLES = new Set(['AXStandardWindow', 'AXUnknown', 'AXContentList', 'AXTextAttachment'])

export const SCREEN_CONTENT_OPEN = '<screen_content untrusted="true">'
export const SCREEN_CONTENT_CLOSE = '</screen_content>'

function words(ax: string): string {
  return ax
    .replace(/^AX/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
}

export function roleLabel(node: Pick<AxNode, 'role' | 'subrole'>): string {
  if (node.subrole && !PLAIN_SUBROLES.has(node.subrole)) return words(node.subrole)
  return words(node.role)
}

function quote(text: string): string {
  return `"${text.replace(/"/g, '\\"')}"`
}

function shortAction(action: string): string {
  return words(action).replace(/\s+/g, '_')
}

function meaningful(node: AxNode): boolean {
  if (!TRANSPARENT_ROLES.has(node.role)) return true
  if (node.title || node.value || node.desc) return true
  return node.actions.some((a) => !QUIET_ACTIONS.has(a))
}

export interface FormattedTree {
  lines: string[]
  handles: Map<number, ElementHandle>
  focusedIndex: number | null
  /** URL da área web visível (navegadores) */
  url: string | null
}

export function formatTree(tree: TreeSnapshot, geometry: ShotGeometry): FormattedTree {
  const children = new Map<number, AxNode[]>()
  for (const node of tree.nodes) {
    if (node.parent < 0) continue
    const list = children.get(node.parent) ?? []
    list.push(node)
    children.set(node.parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.path[a.path.length - 1] - b.path[b.path.length - 1])

  const lines: string[] = []
  const handles = new Map<number, ElementHandle>()
  let focusedIndex: number | null = null
  let url: string | null = null
  let next = 0

  const visit = (node: AxNode, depth: number) => {
    if (node.role === 'AXWebArea' && node.url && !url) url = node.url
    const show = node.parent < 0 || meaningful(node)
    let childDepth = depth
    if (show) {
      const index = next++
      handles.set(index, {
        index,
        path: node.path,
        role: node.role,
        title: node.title,
        frame: node.frame,
        actions: node.actions,
        secure: node.secure,
      })
      if (tree.focusedId === node.id) focusedIndex = index
      lines.push(`${'\t'.repeat(depth)}${index} ${describe(node, geometry)}`)
      childDepth = depth + 1
    }
    for (const child of children.get(node.id) ?? []) visit(child, childDepth)
  }
  const root = tree.nodes.find((n) => n.parent < 0)
  if (root) visit(root, 0)
  return { lines, handles, focusedIndex, url }
}

function describe(node: AxNode, geometry: ShotGeometry): string {
  const parts = [roleLabel(node)]
  if (node.title) parts.push(quote(node.title))
  if (node.secure) parts.push('= [secure — never type here]')
  else if (node.value && node.value !== node.title) parts.push(`= ${quote(node.value)}`)
  else if (!node.value && node.placeholder) parts.push(`placeholder=${quote(node.placeholder)}`)
  if (node.desc && node.desc !== node.title && node.desc !== node.value) parts.push(`(${node.desc})`)
  if (node.url && (node.role === 'AXLink' || node.role === 'AXWebArea')) parts.push(`<${node.url}>`)
  const flags: string[] = []
  if (node.focused) flags.push('focused')
  if (!node.enabled) flags.push('disabled')
  if (node.selected) flags.push('selected')
  if (flags.length) parts.push(`[${flags.join(', ')}]`)
  const actions = node.actions.filter((a) => !QUIET_ACTIONS.has(a))
  if (actions.length) parts.push(`actions: ${actions.map(shortAction).join(', ')}`)
  const at = frameText(node.frame, geometry)
  if (at) parts.push(at)
  if (node.omittedChildren) parts.push(`(+${node.omittedChildren} children not shown)`)
  return parts.join(' ')
}

function frameText(frame: Frame | null, geometry: ShotGeometry): string | null {
  if (!frame) return null
  if (!visibleIn(geometry.frame, frame)) return 'offscreen'
  const [x, y, w, h] = globalToShot(geometry, frame)
  return `@${x},${y} ${w}x${h}`
}
