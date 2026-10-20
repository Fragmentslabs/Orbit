/**
 * O lado do PAINEL da ponte com os artboards (o outro lado é
 * electron/lib/design/design-runtime.ts, injetado em cada artboard). Aqui ficam
 * os tipos das mensagens, a validação delas — o artboard é conteúdo do modelo,
 * nunca confiável — e a edição do FONTE: o painel acha o elemento pelo mesmo
 * caminho de filhos que a ponte usa e reescreve o arquivo.
 */

export const DESIGN_SOURCE = "orbit-design"

export type ElementPath = number[]

export interface DesignRect {
  x: number
  y: number
  w: number
  h: number
}

export type DesignNodeKind = "text" | "image" | "svg" | "input" | "box"

export interface DesignTreeNode {
  tag: string
  label: string
  text: string
  kind: DesignNodeKind
  path: ElementPath
  children: DesignTreeNode[]
}

export interface DesignElementInfo {
  tag: string
  label: string
  kind: DesignNodeKind
  /** Conteúdo de texto, só quando o elemento é uma folha de texto. */
  text: string | null
  rect: DesignRect | null
  /** Valor no `style` do elemento (o que o painel edita). */
  inline: Record<string, string>
  /** Valor calculado (o placeholder do campo). */
  computed: Record<string, string>
  attrs: Record<string, string>
  html: string
  /**
   * Propriedades que DIFEREM entre os elementos selecionados — o painel
   * mostra "Mixed" nelas em vez de um valor (como no Figma).
   */
  mixed?: string[]
  /** Atributos que diferem entre os elementos selecionados. */
  mixedAttrs?: string[]
  /** O TEXTO dos selecionados é diferente entre eles. */
  mixedText?: boolean
}

export type RuntimeMessage =
  | { type: "ready"; tree: DesignTreeNode; width: number; height: number; links: string[] }
  | { type: "navigate"; href: string }
  | { type: "tree"; tree: DesignTreeNode }
  | { type: "hover"; path: ElementPath | null; rect: DesignRect | null }
  | { type: "select"; path: ElementPath | null; info: DesignElementInfo | null; shift: boolean; group: ElementPath[] }
  | { type: "info"; path: ElementPath | null; info: DesignElementInfo | null }
  | { type: "rects"; selected: DesignRect | null; hover: DesignRect | null; group: DesignRect[] }
  | { type: "wheel"; dx: number; dy: number; mode: number; ctrl: boolean; shift: boolean; x: number; y: number }
  | { type: "key"; phase: "down" | "up"; key: string; code: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }
  | { type: "focus" }
  | { type: "textEdited"; path: ElementPath; html: string }
  | { type: "reorder"; parent: ElementPath; order: number[] }
  | { type: "move"; paths: ElementPath[]; parent: ElementPath; index: number }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/**
 * O caminho termina em índice NEGATIVO quando o alvo é um NÓ DE TEXTO — o
 * texto solto dentro de um elemento (o "posts" de `<span><b>128</b> posts</span>`).
 * O número é o do nó na lista de filhos do elemento, com o sinal trocado;
 * elementos são sempre positivos (o caminho de um elemento é a lista de
 * índices de filhos-ELEMENTO).
 */
export const isTextPath = (path: ElementPath): boolean => path.length > 0 && path[path.length - 1] < 0

/**
 * Valida um caminho. `allowText` libera o último índice NEGATIVO (o caminho
 * de um nó de texto solto); sem ele, só caminhos de ELEMENTO passam — é o
 * caso de tudo que move ou agrupa (texto solto não se move nem forma grupo).
 */
function asPath(value: unknown, allowText = true): ElementPath | null {
  if (!Array.isArray(value) || value.length > 64) return null
  const ok = value.every((n, i) =>
    Number.isInteger(n) && (n >= 0 || (allowText && n < 0 && i === value.length - 1 && n >= -4096)),
  )
  return ok ? (value as number[]) : null
}

function asRect(value: unknown): DesignRect | null {
  const r = value as Record<string, unknown> | null
  if (!r || typeof r !== "object") return null
  return isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h) ? { x: r.x, y: r.y, w: r.w, h: r.h } : null
}

/** Caminhos válidos de uma seleção múltipla (o que não endereça nada é descartado). */
function asPathList(value: unknown): ElementPath[] {
  if (!Array.isArray(value)) return []
  const out: ElementPath[] = []
  for (const item of value) {
    // O grupo é um conjunto de irmãos que se movem juntos: só elementos.
    const path = asPath(item, false)
    if (path && path.length > 0) out.push(path)
    if (out.length >= 500) break
  }
  return out
}

/** Retângulos válidos dos demais membros da seleção múltipla. */
function asRectList(value: unknown): DesignRect[] {
  if (!Array.isArray(value)) return []
  const out: DesignRect[] = []
  for (const item of value) {
    const rect = asRect(item)
    if (rect) out.push(rect)
    if (out.length >= 500) break
  }
  return out
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== "object") return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v.slice(0, 2000)
  }
  return out
}

const KINDS = new Set<DesignNodeKind>(["text", "image", "svg", "input", "box"])

function asTree(value: unknown, depth = 0): DesignTreeNode | null {
  const n = value as Record<string, unknown> | null
  if (!n || typeof n !== "object" || depth > 64) return null
  const path = asPath(n.path)
  if (!path || typeof n.tag !== "string") return null
  const children = Array.isArray(n.children)
    ? n.children.map((c) => asTree(c, depth + 1)).filter((c): c is DesignTreeNode => c !== null)
    : []
  return {
    tag: n.tag.slice(0, 40),
    label: typeof n.label === "string" ? n.label.slice(0, 80) : "",
    text: typeof n.text === "string" ? n.text.slice(0, 80) : "",
    kind: KINDS.has(n.kind as DesignNodeKind) ? (n.kind as DesignNodeKind) : "box",
    path,
    children,
  }
}

function asInfo(value: unknown): DesignElementInfo | null {
  const i = value as Record<string, unknown> | null
  if (!i || typeof i !== "object" || typeof i.tag !== "string") return null
  const names = (v: unknown) =>
    Array.isArray(v) ? v.filter((n): n is string => typeof n === "string").slice(0, 200) : []
  return {
    tag: i.tag.slice(0, 40),
    label: typeof i.label === "string" ? i.label.slice(0, 80) : "",
    kind: KINDS.has(i.kind as DesignNodeKind) ? (i.kind as DesignNodeKind) : "box",
    text: typeof i.text === "string" ? i.text.slice(0, 5000) : null,
    rect: asRect(i.rect),
    inline: asStringMap(i.inline),
    computed: asStringMap(i.computed),
    attrs: asStringMap(i.attrs),
    html: typeof i.html === "string" ? i.html.slice(0, 2100) : "",
    mixed: names(i.mixed),
    mixedAttrs: names(i.mixedAttrs),
    mixedText: i.mixedText === true,
  }
}

/** Valida uma mensagem artboard → painel. O que não casa é descartado. */
export function parseRuntimeMessage(raw: unknown): RuntimeMessage | null {
  const m = raw as Record<string, unknown> | null
  if (!m || typeof m !== "object" || m.source !== DESIGN_SOURCE) return null
  switch (m.type) {
    case "ready": {
      const tree = asTree(m.tree)
      return tree
        ? {
            type: "ready",
            tree,
            width: isNum(m.width) ? m.width : 0,
            height: isNum(m.height) ? m.height : 0,
            links: Array.isArray(m.links) ? m.links.filter((l): l is string => typeof l === "string").slice(0, 50) : [],
          }
        : null
    }
    case "navigate":
      return typeof m.href === "string" ? { type: "navigate", href: m.href.slice(0, 500) } : null
    case "tree": {
      const tree = asTree(m.tree)
      return tree ? { type: "tree", tree } : null
    }
    case "hover":
      return { type: "hover", path: asPath(m.path), rect: asRect(m.rect) }
    case "select":
      return { type: "select", path: asPath(m.path), info: asInfo(m.info), shift: m.shift === true, group: asPathList(m.group) }
    case "info":
      return { type: "info", path: asPath(m.path), info: asInfo(m.info) }
    case "rects":
      return { type: "rects", selected: asRect(m.selected), hover: asRect(m.hover), group: asRectList(m.group) }
    case "wheel":
      return isNum(m.dx) && isNum(m.dy)
        ? { type: "wheel", dx: m.dx, dy: m.dy, mode: isNum(m.mode) ? m.mode : 0, ctrl: m.ctrl === true, shift: m.shift === true, x: isNum(m.x) ? m.x : 0, y: isNum(m.y) ? m.y : 0 }
        : null
    case "key":
      return typeof m.key === "string"
        ? {
            type: "key",
            phase: m.phase === "up" ? "up" : "down",
            key: m.key.slice(0, 20),
            code: typeof m.code === "string" ? m.code.slice(0, 20) : "",
            ctrl: m.ctrl === true,
            meta: m.meta === true,
            shift: m.shift === true,
            alt: m.alt === true,
          }
        : null
    case "focus":
      return { type: "focus" }
    case "textEdited": {
      const path = asPath(m.path)
      return path && typeof m.html === "string" ? { type: "textEdited", path, html: m.html.slice(0, 200_000) } : null
    }
    case "reorder": {
      const parent = asPath(m.parent)
      const order = Array.isArray(m.order) ? m.order : null
      if (!parent || !order || order.length === 0 || order.length > 5000) return null
      const seen = new Set<number>()
      for (const n of order) {
        if (!Number.isInteger(n) || n < 0 || n >= order.length || seen.has(n)) return null
        seen.add(n)
      }
      return { type: "reorder", parent, order: order as number[] }
    }
    case "move": {
      const raw = Array.isArray(m.paths) ? m.paths : null
      if (!raw || raw.length === 0 || raw.length > 500) return null
      const paths: ElementPath[] = []
      const seen = new Set<string>()
      for (const item of raw) {
        // Mover é coisa de ELEMENTO: texto solto não sai do lugar.
        const path = asPath(item, false)
        if (!path || path.length === 0) return null
        const key = path.join(",")
        if (seen.has(key)) return null
        seen.add(key)
        paths.push(path)
      }
      const parent = asPath(m.parent)
      if (!parent) return null
      if (!Number.isInteger(m.index) || (m.index as number) < 0 || (m.index as number) > 5000) return null
      return { type: "move", paths, parent, index: m.index as number }
    }
    default:
      return null
  }
}

/**
 * O artboard que um `href` relativo aponta, entre os do canvas (ou null).
 * Ignora query/hash e o prefixo `./`; compara sem diferenciar caixa, porque o
 * agente escreve `pricing.html` para o arquivo `Pricing.html`.
 */
export function boardForHref(href: string, files: string[]): string | null {
  let target = href.split("#")[0].split("?")[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }
  target = target.replace(/^\.\//, "").replace(/^\//, "")
  if (!target) return null
  const lower = target.toLowerCase()
  return files.find((file) => file.toLowerCase() === lower) ?? null
}

export const samePath = (a: ElementPath | null | undefined, b: ElementPath | null | undefined) =>
  Boolean(a && b && a.length === b.length && a.every((n, i) => n === b[i]))

// ------------------------------------------------------------------ fonte

/** O elemento do caminho dentro do <body> de um documento. */
export function elementAt(doc: Document, path: ElementPath): Element | null {
  let el: Element | null = doc.body
  for (const index of path) {
    el = el?.children[index] ?? null
    if (!el) return null
  }
  return el
}

/**
 * O nó de TEXTO do caminho (o caminho termina em índice negativo). É o texto
 * solto dentro de um elemento — uma camada que não tem tag nem estilo, só
 * conteúdo.
 */
export function textNodeAt(doc: Document, path: ElementPath): Text | null {
  if (!isTextPath(path)) return null
  const parent = elementAt(doc, path.slice(0, -1))
  if (!parent) return null
  const node = parent.childNodes[-path[path.length - 1] - 1]
  return node && node.nodeType === 3 ? (node as Text) : null
}

/**
 * Aplica `mutate` ao elemento do caminho no FONTE do artboard e devolve o HTML
 * novo. O DOMParser não executa nada do documento (scripts ficam inertes) e o
 * resultado só vira texto — nada disso entra no DOM do app.
 */
export function editHtml(html: string, path: ElementPath, mutate: (el: Element, doc: Document) => void): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const el = elementAt(doc, path)
  if (!el) throw new Error("element not found in the artboard source")
  mutate(el, doc)
  return serializeHtml(doc, html)
}

function serializeHtml(doc: Document, source: string): string {
  const doctype = doc.doctype || /^\s*<!doctype/i.test(source) ? "<!doctype html>\n" : ""
  return `${doctype}${doc.documentElement.outerHTML}\n`
}

/**
 * Move os elementos de `fromPaths` para dentro do pai de `parentPath`, na
 * posição `index` entre os filhos-ELEMENTO (antes do elemento que hoje está lá;
 * no fim, se não houver). Caminhos no MESMO documento antes de qualquer mutação
 * — todos os elementos são resolvidos primeiro, então mover dentro/para fora de
 * um ramo afetado não desalinha os endereços. Os elementos precisam ser irmãos:
 * um grupo da seleção múltipla se move como bloco, na ordem em que está no DOM.
 */
export function moveElements(html: string, fromPaths: ElementPath[], parentPath: ElementPath, index: number): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const parent = elementAt(doc, parentPath)
  if (!parent) throw new Error("move: target not found in the artboard source")
  if (!Array.isArray(fromPaths) || fromPaths.length === 0) throw new Error("move: no source elements")
  const froms: Element[] = []
  for (const path of fromPaths) {
    const el = elementAt(doc, path)
    if (!el) throw new Error("move: element not found in the artboard source")
    if (froms.indexOf(el) < 0) froms.push(el)
  }
  const sourceParent = froms[0].parentElement
  if (!sourceParent || froms.some((el) => el.parentElement !== sourceParent)) throw new Error("move: sources must share a parent")
  if (sourceParent === parent) throw new Error("move: source and target share the same parent")
  if (froms.some((el) => el === parent || el.contains(parent))) throw new Error("move: cannot move an element into itself")
  const children = parent.children
  if (!Number.isInteger(index) || index < 0 || index > children.length) throw new Error("move: bad index")
  const ordered = froms.slice().sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1))
  const reference = children[index] ?? null
  for (const el of ordered) parent.insertBefore(el, reference)
  return serializeHtml(doc, html)
}

/**
 * Reordena os FILHOS-ELEMENTO de `parent` segundo `order`: a posição `k` passa
 * a ser ocupada pelo filho que estava em `order[k]`. Os nós de texto ficam nos
 * mesmos lugares (é assim que o arraste ao vivo na ponte mexe no DOM), então o
 * fonte reescrito reproduz exatamente o que estava na tela.
 */
export function reorderChildren(parent: Element, order: number[]): void {
  const nodes = Array.from(parent.childNodes)
  const elements = nodes.filter((node): node is Element => node.nodeType === 1)
  if (elements.length !== order.length) throw new Error("reorder: child count mismatch")
  if (order.some((i) => !Number.isInteger(i) || i < 0 || i >= elements.length)) throw new Error("reorder: bad order")
  const next = order.map((i) => elements[i])
  let k = 0
  const rebuilt = nodes.map((node) => (node.nodeType === 1 ? next[k++] : node))
  for (const node of rebuilt) parent.appendChild(node)
}

/**
 * Onde o elemento cai quando é solto sobre um alvo: ANTES dele, DEPOIS dele ou
 * DENTRO dele (vira filho).
 */
export type DropMode = "before" | "after" | "inside"

export interface LayerMovePlan {
  /** O pai de destino. */
  parent: ElementPath
  /** A posição entre os filhos-ELEMENTO do pai. */
  index: number
  /**
   * A nova ordem dos filhos do pai (posição → índice original) — só quando o
   * drop é entre irmãos. `null` quando o elemento muda de pai.
   */
  order: number[] | null
}

/**
 * A nova ordem dos filhos depois de mover o filho `fromIndex` para a posição
 * `toIndex` (posição dada na lista ANTES de tirar o elemento: depois dele, os
 * irmãos escorrem um lugar). A ordem é "posição → índice original", a mesma
 * coisa que o `reorder` da ponte e o `reorderChildren` do fonte falam.
 */
export function orderAfterMove(count: number, fromIndex: number, toIndex: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i)
  if (fromIndex < 0 || fromIndex >= count) return order
  const to = Math.max(0, Math.min(count - 1, fromIndex < toIndex ? toIndex - 1 : toIndex))
  const [moved] = order.splice(fromIndex, 1)
  order.splice(to, 0, moved)
  return order
}

/**
 * Planeja o arrasto de uma camada na lista de Camadas: diz para onde o
 * elemento vai e o que o painel precisa escrever no fonte. O cálculo sai do
 * FONTE (e não da árvore da tela) porque é o fonte que manda nos índices — e
 * é nele que a mudança será gravada.
 *
 * No mesmo pai, o drop vira uma NOVA ORDEM dos filhos (os nós de texto ficam
 * onde estão — é assim que o arraste ao vivo mexe no DOM). Em outro pai, vira
 * pai + índice.
 */
export function planLayerMove(html: string, fromPath: ElementPath, targetPath: ElementPath, mode: DropMode): LayerMovePlan | null {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const from = elementAt(doc, fromPath)
  const target = elementAt(doc, targetPath)
  if (!from || !target || from === target) return null
  // Não entra dentro de si mesmo (nem de um descendente seu).
  if (from.contains(target)) return null
  const sourceParent = from.parentElement
  if (!sourceParent) return null
  if (mode === "inside") {
    return { parent: targetPath, index: target.children.length, order: null }
  }
  const parent = target.parentElement
  if (!parent) return null
  const parentPath = targetPath.slice(0, -1)
  const targetIndex = targetPath[targetPath.length - 1]
  const index = mode === "before" ? targetIndex : targetIndex + 1
  if (parent !== sourceParent) return { parent: parentPath, index, order: null }
  // Mesmo pai: a nova ordem dos filhos, com o elemento trocado de lugar.
  const kids = Array.from(parent.children)
  const fromIndex = kids.indexOf(from)
  if (fromIndex < 0) return null
  const order = orderAfterMove(kids.length, fromIndex, index)
  return { parent: parentPath, index, order }
}

/**
 * Troca o conteúdo de um nó de TEXTO solto (o caminho termina em índice
 * negativo). Texto solto não tem tag nem estilo — só conteúdo.
 */
export function setTextNode(html: string, path: ElementPath, value: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const node = textNodeAt(doc, path)
  if (!node) throw new Error("text: node not found in the artboard source")
  node.data = value
  return serializeHtml(doc, html)
}

/**
 * Apaga vários nós de uma vez (a seleção múltipla): elementos e textos
 * soltos. Os endereços são resolvidos ANTES de qualquer remoção — senão apagar
 * o primeiro mudaria o caminho do segundo.
 */
export function removeNodes(html: string, paths: ElementPath[]): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const nodes: Node[] = []
  for (const path of paths) {
    const el = elementAt(doc, path)
    const node: Node | null = el ?? textNodeAt(doc, path)
    if (node && nodes.indexOf(node) < 0) nodes.push(node)
  }
  if (nodes.length === 0) throw new Error("remove: node not found in the artboard source")
  for (const node of nodes) node.parentNode?.removeChild(node)
  return serializeHtml(doc, html)
}

/**
 * Onde o grupo de camadas vai caber: o pai, a posição do wrapper entre os
 * filhos e os elementos que entram nele (na ordem do DOM).
 */
export interface WrapPlan {
  parent: ElementPath
  index: number
  children: ElementPath[]
}

/**
 * Planeja o "envolver": os elementos selecionados viram filhos de um div novo,
 * que entra no lugar do primeiro deles. Só funciona entre irmãos (o grupo da
 * seleção múltipla sempre é).
 */
export function planWrap(html: string, paths: ElementPath[]): WrapPlan | null {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const pairs: { path: ElementPath; el: Element }[] = []
  for (const path of paths) {
    const el = elementAt(doc, path)
    if (!el) return null
    pairs.push({ path, el })
  }
  if (pairs.length < 2) return null
  const parent = pairs[0].el.parentElement
  if (!parent || pairs.some((p) => p.el.parentElement !== parent)) return null
  const kids = Array.from(parent.children)
  const ordered = pairs.slice().sort((a, b) => kids.indexOf(a.el) - kids.indexOf(b.el))
  const index = kids.indexOf(ordered[0].el)
  if (index < 0) return null
  return {
    parent: ordered[0].path.slice(0, -1),
    index,
    children: ordered.map((p) => p.path),
  }
}

/**
 * Aplica o "envolver" no fonte: o div novo entra no lugar do primeiro
 * elemento e leva os outros para dentro dele.
 */
export function applyWrap(html: string, plan: WrapPlan, style: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const parent = elementAt(doc, plan.parent)
  if (!parent) throw new Error("wrap: parent not found in the artboard source")
  const kids: Element[] = []
  for (const path of plan.children) {
    const el = elementAt(doc, path)
    if (!el) throw new Error("wrap: element not found in the artboard source")
    kids.push(el)
  }
  const wrapper = doc.createElement("div")
  wrapper.setAttribute("style", style)
  parent.insertBefore(wrapper, parent.children[plan.index] ?? null)
  for (const el of kids) wrapper.appendChild(el)
  return serializeHtml(doc, html)
}

/**
 * Divide um `style="…"` em declarações, respeitando `;` dentro de parênteses
 * (`url(data:image/png;base64,…)`). Puro.
 */
export function splitDeclarations(style: string): { prop: string; value: string }[] {
  const out: { prop: string; value: string }[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  const push = (chunk: string) => {
    const colon = chunk.indexOf(":")
    if (colon <= 0) return
    const prop = chunk.slice(0, colon).trim()
    const value = chunk.slice(colon + 1).trim()
    if (prop) out.push({ prop, value })
  }
  for (let i = 0; i < style.length; i++) {
    const ch = style[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    else if (ch === ";" && depth === 0) {
      push(style.slice(start, i))
      start = i + 1
    }
  }
  push(style.slice(start))
  return out
}

/**
 * Troca (ou tira, com valor vazio) uma declaração num `style="…"`, mexendo só
 * nela: o resto fica como o autor escreveu — o CSSOM normalizaria tudo (um
 * `#7c3aed` virava `rgb(124, 58, 237)` no arquivo). Puro.
 */
export function withDeclaration(style: string, prop: string, value: string): string {
  const name = prop.trim().toLowerCase()
  const declarations = splitDeclarations(style)
  const index = declarations.findIndex((d) => d.prop.toLowerCase() === name)
  const next = value.trim()
  if (!next) {
    if (index >= 0) declarations.splice(index, 1)
  } else if (index >= 0) {
    declarations[index] = { prop: declarations[index].prop, value: next }
  } else {
    declarations.push({ prop: name, value: next })
  }
  return declarations.map((d) => `${d.prop}: ${d.value}`).join("; ")
}

/** Grava (ou tira, com valor vazio) uma propriedade no `style` do elemento. */
export function setInlineStyle(el: Element, prop: string, value: string): void {
  const next = withDeclaration(el.getAttribute("style") ?? "", prop, value)
  if (next) el.setAttribute("style", next)
  else el.removeAttribute("style")
}

// ------------------------------------------------------------------ cores

/** `rgb(…)`/`rgba(…)`/`#abc` → `#aabbcc` (para o <input type="color">). */
export function toHex(color: string): string | null {
  const value = color.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const h = hex[1]
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase() : `#${h.toLowerCase()}`
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(value)
  if (!rgb) return null
  if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) return null
  const to2 = (n: string) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, "0")
  return `#${to2(rgb[1])}${to2(rgb[2])}${to2(rgb[3])}`
}
