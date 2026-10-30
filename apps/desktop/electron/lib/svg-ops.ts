import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

/**
 * SVG manipulation — which is TEXT, not pixels.
 *
 * That is why this module does not use sharp: recoloring an icon is rewriting
 * attributes, not reprocessing an image. And it is the difference that gives it value — swapping the
 * color of an SVG logo gives back the logo, in the same drawing, at any size;
 * the same swap on a PNG gives back an approximation of what was already there.
 *
 * The opposite path (SVG → PNG) stays with sharp, which already does it. sharp READS
 * SVG but does not WRITE it: vectorizing will never come out of it.
 *
 * Pure text module (no Electron, no IO), to be testable — the same
 * separation as pdf-ops.ts and image-ops.ts.
 */

/** Attributes that carry color in an SVG. `flood-` and `lighting-` show up in
 *  filters; `stop-color` in gradients. */
const COLOR_ATTRS = [
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
  'lighting-color',
  'color',
]

/**
 * Values that LOOK like color and are not.
 *
 * `none` is the absence of paint and swapping it for a color would fill shapes that
 * were outline only. `currentColor` is the CSS inheritance of whoever uses the icon —
 * it is precisely what makes an icon recolorable by the page, and resolving it here
 * would destroy that property. `inherit` and `transparent` for the same reason.
 */
const NOT_A_COLOR = new Set(['none', 'currentcolor', 'inherit', 'transparent'])

/**
 * Comparable form of a color.
 *
 * It normalizes what can be normalized for sure — short hex to
 * long, case — and leaves the rest lowercase, compared literally. It does not
 * translate a name into hex: `white` stays `white`, so a map with
 * `white` matches `white` and one with `#ffffff` matches `#fff`. Inventing the
 * table of 147 CSS names would bring more error than accuracy.
 */
export function normalizeColor(value: string): string {
  const text = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(text)
  if (rgb) {
    const hex = (v: string) => Number(v).toString(16).padStart(2, '0')
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`
  }
  return text
}

function isColor(value: string): boolean {
  const text = value.trim().toLowerCase()
  return text.length > 0 && !NOT_A_COLOR.has(text) && !text.startsWith('url(')
}

export interface SvgInfo {
  width: number | null
  height: number | null
  viewBox: string | null
  /** Colors present, normalized and without repetition — it is what allows asking for the
   *  swap without opening the file to find out what is in there. */
  colors: string[]
}

/** Explicit error when it is not an SVG: the DOMParser accepts almost anything silently and the
 *  result would be a "success" that changed nothing. */
function parse(markup: string): Document {
  // A parser warning does not become noise in the terminal: an editor's SVG brings
  // namespace and entity that xmldom complains about with nothing actually wrong. What
  // matters is the result, checked right below.
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(markup, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    throw new Error('Not an SVG: the root element must be <svg>.')
  }
  return doc as unknown as Document
}

function serialize(doc: Document): string {
  return new XMLSerializer().serializeToString(doc as never)
}

/** Walks every element — xmldom has no querySelectorAll. */
function eachElement(doc: Document, visit: (el: Element) => void): void {
  const walk = (node: Node) => {
    if (node.nodeType === 1) visit(node as Element)
    // In xmldom a text node has a NULL childNodes, not an empty list: reading
    // `.length` directly blows up on the first SVG with a line break inside.
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) walk(children[i])
  }
  walk(doc.documentElement as unknown as Node)
}

/** Colors inside `style="fill:#fff;stroke:red"`. */
function eachStyleColor(
  style: string,
  visit: (prop: string, value: string) => string | null,
): string {
  return style
    .split(';')
    .map((decl) => {
      const at = decl.indexOf(':')
      if (at < 0) return decl
      const prop = decl.slice(0, at).trim().toLowerCase()
      const value = decl.slice(at + 1).trim()
      if (!COLOR_ATTRS.includes(prop) || !isColor(value)) return decl
      const next = visit(prop, value)
      return next === null ? decl : `${decl.slice(0, at)}:${next}`
    })
    .join(';')
}

export function svgInfo(markup: string): SvgInfo {
  const doc = parse(markup)
  const root = doc.documentElement as unknown as Element
  const colors = new Set<string>()

  eachElement(doc, (el) => {
    for (const attr of COLOR_ATTRS) {
      const value = el.getAttribute(attr)
      if (value && isColor(value)) colors.add(normalizeColor(value))
    }
    const style = el.getAttribute('style')
    if (style) {
      eachStyleColor(style, (_prop, value) => {
        colors.add(normalizeColor(value))
        return null
      })
    }
  })

  const size = (name: string) => {
    const raw = root.getAttribute(name)
    if (!raw) return null
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) ? n : null
  }

  return {
    width: size('width'),
    height: size('height'),
    viewBox: root.getAttribute('viewBox'),
    colors: [...colors].sort(),
  }
}

export interface RecolorOptions {
  /** Targeted swap: from → to. The keys are compared normalized. */
  map?: Record<string, string>
  /** Paints EVERY color with this one — the monochrome variant of an icon. */
  all?: string
}

export interface RecolorResult {
  markup: string
  /** How many paints changed. Zero is the honest answer to a map that did not
   *  match anything, and it is what distinguishes it from a silent success. */
  changed: number
}

/**
 * Swaps the colors while keeping the drawing.
 *
 * It reaches the attribute (`fill="#f00"`) and inline style (`style="fill:#f00"`).
 * It does NOT reach a rule inside `<style>`: that is real CSS, with
 * selectors and specificity, and a text replace there hits by luck. The
 * result says how many paints changed, so an SVG painted only by
 * CSS shows up as zero instead of passing as swapped.
 */
export function recolorSvg(markup: string, options: RecolorOptions): RecolorResult {
  const doc = parse(markup)
  const map = new Map<string, string>()
  for (const [from, to] of Object.entries(options.map ?? {})) {
    map.set(normalizeColor(from), to)
  }
  if (map.size === 0 && !options.all) {
    throw new Error('Provide `map` (from → to) or `all` (paints everything with one color).')
  }

  let changed = 0
  const swap = (value: string): string | null => {
    if (options.all) {
      changed++
      return options.all
    }
    const next = map.get(normalizeColor(value))
    if (next === undefined) return null
    changed++
    return next
  }

  eachElement(doc, (el) => {
    for (const attr of COLOR_ATTRS) {
      const value = el.getAttribute(attr)
      if (!value || !isColor(value)) continue
      const next = swap(value)
      if (next !== null) el.setAttribute(attr, next)
    }
    const style = el.getAttribute('style')
    if (style) {
      const next = eachStyleColor(style, (_prop, value) => swap(value))
      if (next !== style) el.setAttribute('style', next)
    }
  })

  return { markup: serialize(doc), changed }
}

/**
 * Changes the display size without touching the drawing.
 *
 * What gives an SVG its scale is the `viewBox`: it is the coordinate system, and
 * width/height are only the size at which that is painted. That is why here the
 * viewBox never changes — touching it would crop or shift the drawing, which is the
 * opposite of resizing.
 *
 * Without a viewBox in the original file, one is created from the size it
 * had; otherwise the new width/height would stretch the content instead of scaling it.
 */
export function resizeSvg(markup: string, size: { width?: number; height?: number }): string {
  if (!size.width && !size.height) throw new Error('Provide width and/or height.')
  const doc = parse(markup)
  const root = doc.documentElement as unknown as Element

  const current = svgInfo(markup)
  if (!current.viewBox && current.width && current.height) {
    root.setAttribute('viewBox', `0 0 ${current.width} ${current.height}`)
  }

  // One side only preserves the viewBox's proportion, which is the behavior
  // expected from "I want this icon 512 wide".
  const box = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const ratio = box.length === 4 && box[2] > 0 && box[3] > 0 ? box[3] / box[2] : null

  const width = size.width ?? (size.height && ratio ? size.height / ratio : null)
  const height = size.height ?? (size.width && ratio ? size.width * ratio : null)

  if (width) root.setAttribute('width', String(Math.round(width)))
  if (height) root.setAttribute('height', String(Math.round(height)))
  return serialize(doc)
}

/**
 * Checks that the markup is a usable SVG, and refuses what is not.
 *
 * A `<script>` inside the file does not run where we show it (served
 * as image/svg+xml and drawn in `<img>`), but it goes along with the file that
 * the person downloads and takes elsewhere. Refusing here is more honest than
 * delivering a file with a payload we are not going to use.
 */
export function assertSafeSvg(markup: string): void {
  parse(markup)
  if (/<\s*script[\s>]/i.test(markup)) {
    throw new Error('SVG with <script> is not accepted: the file leaves here to other places.')
  }
  if (/\son\w+\s*=/i.test(markup)) {
    throw new Error('SVG with an event handler (onload, onclick…) is not accepted.')
  }
}
