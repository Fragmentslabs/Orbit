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

/**
 * ControlType da UIA (Windows) → papel do AX. O host manda o nome cru da UIA e
 * a tradução mora aqui: o resto do módulo, o prompt e o modelo falam um
 * vocabulário só. Papéis do macOS começam com "AX" e passam direto.
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
 * Papel no vocabulário do AX. `Document` é a página no Chromium/Edge e também
 * a área de texto do Bloco de Notas do Windows 11: o host marca o editável com
 * subrole "editable", que vira área de texto — "web area" no Bloco de Notas
 * confundiria o modelo.
 */
export function normalizeRole(node: Pick<AxNode, 'role' | 'subrole' | 'url'>): string {
  if (node.role.startsWith('AX')) return node.role
  if (node.role === 'Document' && node.subrole === 'editable' && !node.url) return 'AXTextArea'
  return UIA_ROLES[node.role] ?? 'AXUnknown'
}

/** O nó no vocabulário do AX (papel traduzido, sem o subrole da UIA). */
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
  /** O índice do elemento de cada linha (lines[i] ↔ indices[i]) — com índices estáveis, não é a posição */
  indices: number[]
  handles: Map<number, ElementHandle>
  /** Identidade do elemento → índice: a próxima observação da mesma janela reaproveita */
  keys: Map<string, number>
  /** Índice → a linha sem recuo nem índice: é ela que o diff compara */
  bodies: Map<number, string>
  focusedIndex: number | null
  /** URL da área web visível (navegadores) */
  url: string | null
}

/**
 * Identidade de um elemento entre duas observações da mesma janela: papel,
 * caminho e título. O valor fica de fora (um campo digitado é o mesmo campo);
 * o título entra porque, depois de a tela mudar, outro botão pode ocupar o
 * mesmo caminho — reaproveitar o índice ali faria um passo planejado contra o
 * botão antigo clicar no novo.
 */
function elementKey(node: AxNode): string {
  return `${node.role}|${node.path.join('.')}|${node.title ?? ''}`
}

/**
 * `previous`: as chaves da observação anterior da MESMA janela. Quem continua
 * na tela mantém o índice (o modelo pode seguir usando o que já leu, e o diff
 * mostra só o que mudou); quem é novo ganha um índice acima de todos os antigos.
 */
export function formatTree(tree: TreeSnapshot, geometry: ShotGeometry, previous?: Map<string, number>): FormattedTree {
  const children = new Map<number, AxNode[]>()
  // O papel cru fica para a ação conferir a identidade no vocabulário do host.
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
