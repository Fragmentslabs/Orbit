/**
 * The PANEL side of the bridge with the artboards (the other side is
 * electron/lib/design/design-runtime.ts, injected into each artboard). Here live
 * the message types, their validation — the artboard is model content,
 * never trustworthy — and the editing of the SOURCE: the panel finds the element by the same
 * child path the bridge uses and rewrites the file.
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
  /** Hidden by the eye of the Layers list (view state of the live DOM). */
  hidden?: boolean
  children: DesignTreeNode[]
}

export interface DesignElementInfo {
  tag: string
  label: string
  kind: DesignNodeKind
  /** Text content, only when the element is a text leaf. */
  text: string | null
  rect: DesignRect | null
  /** Value in the element's `style` (what the panel edits). */
  inline: Record<string, string>
  /** Computed value (the field placeholder). */
  computed: Record<string, string>
  attrs: Record<string, string>
  html: string
  /**
   * Properties that DIFFER among the selected elements — the panel
   * shows "Mixed" on them instead of a value (as in Figma).
   */
  mixed?: string[]
  /** Attributes that differ among the selected elements. */
  mixedAttrs?: string[]
  /** The TEXT of the selected ones is different among them. */
  mixedText?: boolean
}

export type RuntimeMessage =
  | { type: "ready"; tree: DesignTreeNode | null; width: number; height: number; links: string[] }
  | { type: "navigate"; href: string }
  | { type: "tree"; tree: DesignTreeNode }
  | { type: "hover"; path: ElementPath | null; rect: DesignRect | null }
  | { type: "select"; path: ElementPath | null; info: DesignElementInfo | null; shift: boolean; group: ElementPath[] }
  | { type: "info"; path: ElementPath | null; info: DesignElementInfo | null }
  | { type: "rects"; selected: DesignRect | null; hover: DesignRect | null; group: DesignRect[] }
  | { type: "wheel"; dx: number; dy: number; mode: number; ctrl: boolean; shift: boolean; x: number; y: number }
  | { type: "key"; phase: "down" | "up"; key: string; code: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }
  | { type: "focus" }
  | { type: "context"; x: number; y: number }
  | { type: "textEdited"; path: ElementPath; html: string }
  | { type: "reorder"; parent: ElementPath; order: number[] }
  | { type: "move"; paths: ElementPath[]; parent: ElementPath; index: number }

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/**
 * The path ends in a NEGATIVE index when the target is a TEXT NODE — the
 * loose text inside an element (the "posts" of `<span><b>128</b> posts</span>`).
 * The number is that of the node in the element's children list, with the sign flipped;
 * elements are always positive (the path of an element is the list of
 * ELEMENT-child indexes).
 */
export const isTextPath = (path: ElementPath): boolean => path.length > 0 && path[path.length - 1] < 0

/**
 * Validates a path. `allowText` releases the last NEGATIVE index (the path
 * of a loose text node); without it, only ELEMENT paths pass — which is
 * the case of everything that moves or groups (loose text does not move nor form a group).
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

/** Valid paths of a multiple selection (what addresses nothing is discarded). */
function asPathList(value: unknown): ElementPath[] {
  if (!Array.isArray(value)) return []
  const out: ElementPath[] = []
  for (const item of value) {
    // The group is a set of siblings that move together: elements only.
    const path = asPath(item, false)
    if (path && path.length > 0) out.push(path)
    if (out.length >= 500) break
  }
  return out
}

/** Valid rectangles of the other members of the multiple selection. */
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
    ...(n.hidden === true ? { hidden: true } : {}),
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

/** Validates an artboard → panel message. What does not match is discarded. */
export function parseRuntimeMessage(raw: unknown): RuntimeMessage | null {
  const m = raw as Record<string, unknown> | null
  if (!m || typeof m !== "object" || m.source !== DESIGN_SOURCE) return null
  switch (m.type) {
    case "ready":
      // The tree is OPTIONAL: the bridge only sends it when the Layers ask for it (the
      // `tree` message), not on the document load.
      return {
        type: "ready",
        tree: asTree(m.tree),
        width: isNum(m.width) ? m.width : 0,
        height: isNum(m.height) ? m.height : 0,
        links: Array.isArray(m.links) ? m.links.filter((l): l is string => typeof l === "string").slice(0, 50) : [],
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
    case "context":
      return isNum(m.x) && isNum(m.y) ? { type: "context", x: m.x, y: m.y } : null
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
        // Moving is an ELEMENT thing: loose text does not leave its place.
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
 * The artboard a relative `href` points to, among the ones of the canvas (or null).
 * It ignores query/hash and the `./` prefix; it compares case-insensitively, because the
 * agent writes `pricing.html` for the file `Pricing.html`.
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

// ------------------------------------------------------------------ source

/** The element of the path inside the <body> of a document. */
export function elementAt(doc: Document, path: ElementPath): Element | null {
  let el: Element | null = doc.body
  for (const index of path) {
    el = el?.children[index] ?? null
    if (!el) return null
  }
  return el
}

/**
 * The TEXT node of the path (the path ends in a negative index). It is the loose
 * text inside an element — a layer that has neither tag nor style, only
 * content.
 */
export function textNodeAt(doc: Document, path: ElementPath): Text | null {
  if (!isTextPath(path)) return null
  const parent = elementAt(doc, path.slice(0, -1))
  if (!parent) return null
  const node = parent.childNodes[-path[path.length - 1] - 1]
  return node && node.nodeType === 3 ? (node as Text) : null
}

/**
 * Applies `mutate` to the element of the path in the SOURCE of the artboard and returns the new
 * HTML. The DOMParser executes nothing of the document (scripts stay inert) and the
 * result only becomes text — none of it enters the app DOM.
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
 * Moves the elements of `fromPaths` into the parent of `parentPath`, at the
 * `index` position among the ELEMENT children (before the element that is there today;
 * at the end, if there is none). Paths in the SAME document before any mutation
 * — all the elements are resolved first, so moving into/out of an
 * affected branch does not misalign the addresses. The elements need to be siblings:
 * a group of the multiple selection moves as a block, in the order it is in the DOM.
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
 * Reorders the ELEMENT children of `parent` according to `order`: the position `k`
 * becomes occupied by the child that was at `order[k]`. The text nodes stay in the
 * same places (that is how the live drag in the bridge touches the DOM), so the
 * rewritten source reproduces exactly what was on screen.
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
 * Where the element lands when it is dropped over a target: BEFORE it, AFTER it or
 * INSIDE it (becomes a child).
 */
export type DropMode = "before" | "after" | "inside"

export interface LayerMovePlan {
  /** The destination parent. */
  parent: ElementPath
  /** The position among the ELEMENT children of the parent. */
  index: number
  /**
   * The new order of the parent's children (position → original index) — only when the
   * drop is between siblings. `null` when the element changes parent.
   */
  order: number[] | null
}

/**
 * The new order of the children after moving the child `fromIndex` to the position
 * `toIndex` (position given in the list BEFORE taking the element out: after it, the
 * siblings slide one place). The order is "position → original index", the same
 * thing the bridge's `reorder` and the source's `reorderChildren` speak.
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
 * Plans the drag of a layer in the Layers list: it says where the
 * element goes and what the panel needs to write to the source. The calculation comes from the
 * SOURCE (and not from the tree on screen) because it is the source that rules the indexes — and
 * it is in it that the change will be recorded.
 *
 * In the same parent, the drop becomes a NEW ORDER of the children (the text nodes stay
 * where they are — that is how the live drag touches the DOM). In another parent, it becomes
 * parent + index.
 */
export function planLayerMove(html: string, fromPath: ElementPath, targetPath: ElementPath, mode: DropMode): LayerMovePlan | null {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const from = elementAt(doc, fromPath)
  const target = elementAt(doc, targetPath)
  if (!from || !target || from === target) return null
  // It does not enter inside itself (nor inside a descendant of its own).
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
  // Same parent: the new order of the children, with the element swapped in place.
  const kids = Array.from(parent.children)
  const fromIndex = kids.indexOf(from)
  if (fromIndex < 0) return null
  const order = orderAfterMove(kids.length, fromIndex, index)
  return { parent: parentPath, index, order }
}

/**
 * Swaps the content of a loose TEXT node (the path ends in a negative
 * index). Loose text has neither tag nor style — only content.
 */
export function setTextNode(html: string, path: ElementPath, value: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const node = textNodeAt(doc, path)
  if (!node) throw new Error("text: node not found in the artboard source")
  node.data = value
  return serializeHtml(doc, html)
}

/**
 * Deletes several nodes at once (the multiple selection): elements and loose
 * texts. The addresses are resolved BEFORE any removal — otherwise deleting
 * the first would change the path of the second.
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
 * Where the layer group is going to fit: the parent, the position of the wrapper among the
 * children and the elements that enter it (in DOM order).
 */
export interface WrapPlan {
  parent: ElementPath
  index: number
  children: ElementPath[]
}

/**
 * Plans the "wrap": the selected elements become children of a new div,
 * which enters in the place of the first of them. It only works among siblings (the group of the
 * multiple selection always is).
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
 * Applies the "wrap" in the source: the new div enters in the place of the first
 * element and takes the others inside it.
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
 * Splits a `style="…"` into declarations, respecting `;` inside parentheses
 * (`url(data:image/png;base64,…)`). Pure.
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
 * Swaps (or removes, with an empty value) a declaration in a `style="…"`, touching only
 * it: the rest stays as the author wrote it — the CSSOM would normalize everything (a
 * `#7c3aed` became `rgb(124, 58, 237)` in the file). Pure.
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

/** Writes (or removes, with an empty value) a property in the element's `style`. */
export function setInlineStyle(el: Element, prop: string, value: string): void {
  const next = withDeclaration(el.getAttribute("style") ?? "", prop, value)
  if (next) el.setAttribute("style", next)
  else el.removeAttribute("style")
}

// ------------------------------------------------------------------ colors

/** `rgb(…)`/`rgba(…)`/`#abc` → `#aabbcc` (for the <input type="color">). */
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

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Hsv {
  /** 0-360 */
  h: number
  /** 0-1 */
  s: number
  /** 0-1 */
  v: number
}

/** "#rgb"/"#rrggbb" → {r,g,b} (0-255). null when it is not a hex. */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

/** {r,g,b} (0-255) → "#rrggbb". */
export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")
  return `#${part(r)}${part(g)}${part(b)}`
}

/** RGB → HSV (h in degrees, s and v from 0 to 1). */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/** HSV → "#rrggbb". */
export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let rgb: [number, number, number]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return rgbToHex({ r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 })
}

/**
 * Duplicates the nodes of `paths`: each clone enters right after its original.
 * Addresses are resolved BEFORE any change (same contract as removeNodes).
 */
export function duplicateNodes(html: string, paths: ElementPath[]): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const nodes: Node[] = []
  for (const path of paths) {
    const el = elementAt(doc, path)
    const node: Node | null = el ?? textNodeAt(doc, path)
    if (node && nodes.indexOf(node) < 0) nodes.push(node)
  }
  if (nodes.length === 0) throw new Error("duplicate: node not found in the artboard source")
  for (const node of nodes) node.parentNode?.insertBefore(node.cloneNode(true), node.nextSibling)
  return serializeHtml(doc, html)
}

/**
 * The new order of a parent's ELEMENT children when the child `index` moves one
 * step up (earlier in the list) or down. `null` when it is already at the edge.
 */
export function stepOrder(count: number, index: number, direction: "up" | "down"): number[] | null {
  const target = direction === "up" ? index - 1 : index + 1
  if (index < 0 || index >= count || target < 0 || target >= count) return null
  const order = Array.from({ length: count }, (_, i) => i)
  order[index] = target
  order[target] = index
  return order
}
