/**
 * Recording of the graph scene into a SkPicture.
 *
 * A SkPicture is a list of drawing commands recorded ONCE and replayed
 * by the GPU on every frame. It is the difference between the graph moving and the graph
 * freezing: with react-native-svg every circle, stroke and label is a native view, and changing
 * the transform forced the engine to redraw the whole tree on the CPU — a few
 * hundred nodes already failed to keep 60fps on a phone. Here React does not take part
 * in the frame: it records the scene when the CONTENT changes (new layout, zoom level,
 * search) and the UI thread only applies a matrix on top.
 *
 * What remains outside the picture is what changes on a finger touch: the highlight of the
 * selected node, drawn as a normal component on top.
 */
import { Skia, createPicture, PaintStyle } from '@shopify/react-native-skia'
import type { SkFont, SkPaint, SkPicture } from '@shopify/react-native-skia'
import type { GraphIndex, NodeShape } from './graph-index'

export interface Fonts {
  body: SkFont
  area: SkFont
  root: SkFont
}

export interface SceneOptions {
  /** 3 = everything, 2 = no label, 1 = no ring and tree only, 0 = summary per block. */
  level: number
  /** Ids that match the search; null when the search is empty. */
  matches: Set<string> | null
  fonts: Fonts
  textColor: string
}

/** Measured width of the label, stored on the node — measuring is the expensive step of
 *  the recording, and the text does not change between one recording and the next. */
const labelWidths = new WeakMap<NodeShape, number>()

function labelWidth(node: NodeShape, font: SkFont): number {
  const stored = labelWidths.get(node)
  if (stored != null) return stored
  const width = font.measureText(node.label).width
  labelWidths.set(node, width)
  return width
}

/**
 * Converts the theme colors (`hsl(...)`) to hexadecimal. The Skia color parser
 * does not cover hsl, and passing the raw string would return black without warning.
 */
export function toSkiaColor(color: string): string {
  const m = /hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/.exec(color)
  if (!m) return color
  const h = Number(m[1]) / 360
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  if (s === 0) {
    const v = Math.round(l * 255)
    return `#${v.toString(16).padStart(2, '0').repeat(3)}`
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const hex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(channel(h + 1 / 3))}${hex(channel(h))}${hex(channel(h - 1 / 3))}`
}

/** Node opacity: outside the search it fades, forgotten fades more. */
function opacityOf(node: NodeShape, matches: Set<string> | null): number {
  if (matches && !matches.has(node.id)) return 0.18
  return node.stale ? 0.45 : 1
}

function paint(style: PaintStyle): SkPaint {
  const p = Skia.Paint()
  p.setAntiAlias(true)
  p.setStyle(style)
  return p
}

export function recordScene(index: GraphIndex, options: SceneOptions): SkPicture | null {
  if (index.total === 0) return null
  const { level, matches, fonts, textColor } = options
  const bounds = index.bounds
  const box = Skia.XYWHRect(
    bounds.minX,
    bounds.minY,
    Math.max(1, bounds.maxX - bounds.minX),
    Math.max(1, bounds.maxY - bounds.minY),
  )

  return createPicture((canvas) => {
    // Three paints for the whole scene, reconfigured before each command:
    // Skia copies the paint state into the list at drawing time, and
    // creating one per node would only generate garbage.
    const fillPaint = paint(PaintStyle.Fill)
    const strokePaint = paint(PaintStyle.Stroke)
    const textPaint = paint(PaintStyle.Fill)
    textPaint.setColor(Skia.Color(textColor))

    // ── Summary: one dot per block, at the zoom where the node becomes noise ──
    if (level === 0) {
      for (const block of index.blocks) {
        const color = Skia.Color(block.color)
        fillPaint.setColor(color)
        fillPaint.setAlphaf(0.3)
        canvas.drawCircle(block.cx, block.cy, block.radius, fillPaint)
        strokePaint.setColor(color)
        strokePaint.setAlphaf(0.7)
        strokePaint.setStrokeWidth(1)
        canvas.drawCircle(block.cx, block.cy, block.radius, strokePaint)
      }
      // The landmarks stay: they are what says where each project is while the
      // rest is a cloud.
      for (const node of index.landmarks) {
        drawNode(canvas, node, 1, fillPaint, strokePaint)
        if (node.isRoot) drawLabel(canvas, node, fonts.root, textPaint, 1)
      }
      return
    }

    // ── Edges ────────────────────────────────────────────────────────────
    const dashed = Skia.PathEffect.MakeDash([6, 4], 0)
    const dotted = Skia.PathEffect.MakeDash([3, 5], 0)
    for (const edge of index.edges) {
      // Level 1 is the far zoom: only the tree, which is the skeleton of the drawing.
      // The relation edges become an illegible crossing at that scale.
      if (level <= 1 && !edge.tree) continue
      strokePaint.setColor(Skia.Color(edge.color))
      strokePaint.setAlphaf(edge.opacity)
      strokePaint.setStrokeWidth(edge.width)
      strokePaint.setPathEffect(
        edge.dash === '3 5' ? dotted : edge.dash === '6 4' ? dashed : null,
      )
      canvas.drawLine(edge.x1, edge.y1, edge.x2, edge.y2, strokePaint)
    }
    strokePaint.setPathEffect(null)

    // ── Nodes ────────────────────────────────────────────────────────────
    for (const node of index.nodes) {
      const opacity = opacityOf(node, matches)
      if (level >= 2 && node.recent && !node.isRoot) {
        strokePaint.setColor(Skia.Color(node.color))
        strokePaint.setAlphaf(0.5 * opacity)
        strokePaint.setStrokeWidth(1.5)
        canvas.drawCircle(node.x, node.y, node.r + 4, strokePaint)
      }
      drawNode(canvas, node, opacity, fillPaint, strokePaint)
      if (level >= 3 || node.isRoot) {
        const font = node.isRoot ? fonts.root : node.fontSize >= 11 ? fonts.area : fonts.body
        drawLabel(canvas, node, font, textPaint, opacity)
      }
    }
  }, box)
}

/** Node circle: translucent fill + outline in the type color. */
function drawNode(
  canvas: Parameters<Parameters<typeof createPicture>[0]>[0],
  node: NodeShape,
  opacity: number,
  fillPaint: SkPaint,
  strokePaint: SkPaint,
): void {
  const color = Skia.Color(node.color)
  fillPaint.setColor(color)
  fillPaint.setAlphaf(node.fillOpacity * opacity)
  canvas.drawCircle(node.x, node.y, node.r, fillPaint)
  strokePaint.setColor(color)
  strokePaint.setAlphaf(opacity)
  strokePaint.setStrokeWidth(node.strokeWidth)
  canvas.drawCircle(node.x, node.y, node.r, strokePaint)
}

/** Label centered below the circle (Obsidian style). Skia draws
 *  from the baseline to the left, so the centering is ours. */
function drawLabel(
  canvas: Parameters<Parameters<typeof createPicture>[0]>[0],
  node: NodeShape,
  font: SkFont,
  textPaint: SkPaint,
  opacity: number,
): void {
  if (!node.label) return
  textPaint.setAlphaf(opacity)
  canvas.drawText(node.label, node.x - labelWidth(node, font) / 2, node.y + node.labelY, textPaint, font)
}
