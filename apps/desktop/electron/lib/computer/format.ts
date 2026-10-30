import { globalToShot, visibleIn, type ShotGeometry } from './geometry'
import type { ElementHandle } from './registry'
import type { AxNode, Frame, TreeSnapshot } from './types'

/**
 * AX tree → indented text with one index per line. It is the contract with the
 * model: each line says what the element is, what can be done with it and where it
 * is IN THE IMAGE (the frame goes in the screenshot space, the same as the x/y
 * coordinates). Groups with nothing to say get no line — the children come up a
 * level —, because the AX tree is full of empty boxes that only spend tokens.
 */

const TRANSPARENT_ROLES = new Set(['AXGroup', 'AXUnknown', 'AXLayoutArea', 'AXSplitGroup', 'AXLayoutItem'])
const QUIET_ACTIONS = new Set(['AXScrollToVisible', 'AXShowDefaultUI', 'AXShowAlternateUI'])

/** Subroles that say nothing beyond the role. */
const PLAIN_SUBROLES = new Set(['AXStandardWindow', 'AXUnknown', 'AXContentList', 'AXTextAttachment'])

/**
 * UIA ControlType (Windows) → AX role. The host sends the raw UIA name and the
 * translation lives here: the rest of the module, the prompt and the model speak a
 * single vocabulary. macOS roles start with "AX" and pass through.
 */
const UIA_ROLES: Record<string, string> = {
  AppBar: 'AXToolbar',
  Button: 'AXButton',
  Calendar: 'AXGroup',
  CheckBox: 'AXCheckBox',
  ComboBox: 'AXComboBox',
  Custom: 'AXUnknown',
  DataGrid: 'AXTable',
  DataItem: 'AXRow',
  Document: 'AXWebArea',
  Edit: 'AXTextField',
  Group: 'AXGroup',
  Header: 'AXGroup',
  HeaderItem: 'AXColumnHeader',
  Hyperlink: 'AXLink',
  Image: 'AXImage',
  List: 'AXList',
  ListItem: 'AXListItem',
  Menu: 'AXMenu',
  MenuBar: 'AXMenuBar',
  MenuItem: 'AXMenuItem',
  Pane: 'AXGroup',
  ProgressBar: 'AXProgressIndicator',
  RadioButton: 'AXRadioButton',
  ScrollBar: 'AXScrollBar',
  SemanticZoom: 'AXGroup',
  Separator: 'AXSplitter',
  Slider: 'AXSlider',
  Spinner: 'AXIncrementor',
  SplitButton: 'AXMenuButton',
  StatusBar: 'AXStatusBar',
  Tab: 'AXTabGroup',
  TabItem: 'AXTab',
  Table: 'AXTable',
  Text: 'AXStaticText',
  Thumb: 'AXValueIndicator',
  TitleBar: 'AXGroup',
  ToolBar: 'AXToolbar',
  ToolTip: 'AXHelpTag',
  Tree: 'AXOutline',
  TreeItem: 'AXTreeItem',
  Window: 'AXWindow',
}

/**
 * Role in the AX vocabulary. `Document` is the page in Chromium/Edge and also the
 * text area of Windows 11 Notepad: the host marks the editable one with the subrole
 * "editable", which becomes a text area — "web area" in Notepad would confuse the
 * model.
 */
export function normalizeRole(node: Pick<AxNode, 'role' | 'subrole' | 'url'>): string {
  if (node.role.startsWith('AX')) return node.role
  if (node.role === 'Document' && node.subrole === 'editable' && !node.url) return 'AXTextArea'
  return UIA_ROLES[node.role] ?? 'AXUnknown'
}

/** The node in the AX vocabulary (translated role, without the UIA subrole). */
export function normalizeNode(node: AxNode): AxNode {
  if (node.role.startsWith('AX')) return node
  return { ...node, role: normalizeRole(node), subrole: null }
}

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
  /** The element index of each line (lines[i] ↔ indices[i]) — with stable indices, it is not the position */
  indices: number[]
  handles: Map<number, ElementHandle>
  /** Element identity → index: the next observation of the same window reuses it */
  keys: Map<string, number>
  /** Index → the line without indent or index: it is what the diff compares */
  bodies: Map<number, string>
  focusedIndex: number | null
  /** URL of the visible web area (browsers) */
  url: string | null
}

/**
 * Identity of an element between two observations of the same window: role, path
 * and title. The value stays out (a typed field is the same field); the title comes
 * in because, after the screen changes, another button may take the same path —
 * reusing the index there would make a step planned against the old button click the
 * new one.
 */
function elementKey(node: AxNode): string {
  return `${node.role}|${node.path.join('.')}|${node.title ?? ''}`
}

/**
 * `previous`: the keys of the previous observation of the SAME window. Whoever stays
 * on screen keeps the index (the model can keep using what it already read, and the
 * diff shows only what changed); whoever is new gets an index above all the old ones.
 */
export function formatTree(tree: TreeSnapshot, geometry: ShotGeometry, previous?: Map<string, number>): FormattedTree {
  const children = new Map<number, AxNode[]>()
  // The raw role stays for the action to check the identity in the host's vocabulary.
  const native = new Map(tree.nodes.map((n) => [n.id, n.role]))
  const nodes = tree.nodes.map(normalizeNode)
  for (const node of nodes) {
    if (node.parent < 0) continue
    const list = children.get(node.parent) ?? []
    list.push(node)
    children.set(node.parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.path[a.path.length - 1] - b.path[b.path.length - 1])

  const lines: string[] = []
  const indices: number[] = []
  const handles = new Map<number, ElementHandle>()
  const keys = new Map<string, number>()
  const bodies = new Map<number, string>()
  let focusedIndex: number | null = null
  let url: string | null = null
  let next = previous?.size ? Math.max(...previous.values()) + 1 : 0

  const visit = (node: AxNode, depth: number) => {
    if (node.role === 'AXWebArea' && node.url && !url) url = node.url
    const show = node.parent < 0 || meaningful(node)
    let childDepth = depth
    if (show) {
      const key = elementKey(node)
      const kept = previous?.get(key)
      const index = kept !== undefined && !handles.has(kept) ? kept : next++
      keys.set(key, index)
      handles.set(index, {
        index,
        path: node.path,
        ...(node.ref ? { ref: node.ref } : {}),
        role: node.role,
        nativeRole: native.get(node.id) ?? node.role,
        title: node.title,
        frame: node.frame,
        actions: node.actions,
        secure: node.secure,
      })
      if (tree.focusedId === node.id) focusedIndex = index
      const body = describe(node, geometry)
      bodies.set(index, body)
      lines.push(`${'\t'.repeat(depth)}${index} ${body}`)
      indices.push(index)
      childDepth = depth + 1
    }
    for (const child of children.get(node.id) ?? []) visit(child, childDepth)
  }
  const root = nodes.find((n) => n.parent < 0)
  if (root) visit(root, 0)
  return { lines, indices, handles, keys, bodies, focusedIndex, url }
}

export interface TreeDiff {
  added: number[]
  changed: number[]
  removed: number[]
}

export function diffTrees(before: Map<number, string>, after: Map<number, string>): TreeDiff {
  const added: number[] = []
  const changed: number[] = []
  const removed: number[] = []
  for (const [index, body] of after) {
    const old = before.get(index)
    if (old === undefined) added.push(index)
    else if (old !== body) changed.push(index)
  }
  for (const index of before.keys()) if (!after.has(index)) removed.push(index)
  return { added, changed, removed }
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
