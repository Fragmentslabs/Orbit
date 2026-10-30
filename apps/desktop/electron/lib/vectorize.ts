import sharp from 'sharp'
import { labOf } from './image-ops'

/**
 * Vectorization: raster image → SVG with real paths.
 *
 * Written here, and not taken from a library, because of licensing: potrace — the
 * reference on the subject — is GPL-2.0, and Orbit is distributed under the Business
 * Source License. Linking one against the other would force opening the whole app.
 *
 * The path has three steps, and the first is what makes the other two
 * simple: sharp QUANTIZES the image into a handful of flat colors, and from
 * there "finding the shape" stops being image analysis and becomes geometry over
 * a binary mask.
 *
 *   quantize → trace each color → simplify
 *
 * What this does well: logo, icon, line art, silhouette — things made
 * of flat regions. What it does NOT do: photography. There every gradient becomes
 * dozens of bands and the result comes out bigger than the original and ugly. The report
 * returned exists to recognize that case without having to open the file.
 *
 * Pure bytes module (no Electron, no IO), to be testable.
 */

/** Above this the tracing generates too many paths to be useful — and the image is
 *  reduced before it, which also smooths the quantization's jaggedness. */
const MAX_SIDE = 1000

/**
 * Below this ΔE two colors are the same color to the eye.
 *
 * The "perceptible difference" threshold is around 2.3; here it is a little more
 * generous because the goal is not color fidelity, it is finding SHAPE — and two
 * colors nobody distinguishes should never become two outlines.
 */
const IDENTICAL_DELTA_E = 6

/**
 * How close to the line between two colors the mixture has to fall.
 *
 * A real transition between two tones is, by construction, their average — so
 * it lands almost exactly on top of the segment that links them in LAB. A real color
 * of the drawing has no reason at all to fall there.
 */
const BLEND_LINE_DISTANCE = 12

export interface VectorizeOptions {
  /**
   * How many colors to keep, or 'auto' (default). Few = cleaner drawing;
   * many = more faithful — and it is a choice that depends on the image, not on whoever
   * calls: a battered file needs fewer colors precisely because the
   * extra ones it has are noise.
   */
  colors?: number | 'auto'
  /** Ignores blobs smaller than this, in pixels. Removes the dirt from the
   *  quantization without eating real detail. */
  minArea?: number
  /** Simplification tolerance, in pixels. Larger = fewer points, straighter
   *  outline. */
  tolerance?: number
  /** Does not draw the background color (the one that fills the edges): it is what delivers a
   *  cut-out icon instead of a colored rectangle. */
  dropBackground?: boolean
}

export interface VectorizeResult {
  svg: string
  /** How many colors were actually used — the number 'auto' chose. */
  usedColors: number
  width: number
  height: number
  /** Colors drawn, from the largest area to the smallest. */
  colors: string[]
  paths: number
  points: number
  /**
   * Honest reading of the result. A vectorized photo "works" — it produces a valid
   * SVG — and is garbage: thousands of paths, a file bigger than the source.
   * Whoever called needs to know that without opening the file.
   */
  warnings: string[]
}

type Point = [number, number]

/** Outlines of a binary mask, in pixel EDGE coordinates.
 *
 * Each lit pixel contributes the edges that border an off pixel,
 * oriented so that the interior is always on the same side. This makes the
 * outer outline and the one of a hole come out with opposite directions — which is
 * exactly what the SVG's `fill-rule` uses to hollow out the middle of a ring without
 * anyone having to say which outline is a hole.
 */
function contours(mask: Uint8Array, width: number, height: number): Point[][] {
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1

  // Directed edge: key of the starting point → possible end points.
  const edges = new Map<string, Point[]>()
  const key = (p: Point) => `${p[0]},${p[1]}`
  const add = (from: Point, to: Point) => {
    const k = key(from)
    const list = edges.get(k)
    if (list) list.push(to)
    else edges.set(k, [to])
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue
      if (!on(x, y - 1)) add([x, y], [x + 1, y])
      if (!on(x + 1, y)) add([x + 1, y], [x + 1, y + 1])
      if (!on(x, y + 1)) add([x + 1, y + 1], [x, y + 1])
      if (!on(x - 1, y)) add([x, y + 1], [x, y])
    }
  }

  const loops: Point[][] = []
  while (edges.size > 0) {
    const first = edges.keys().next().value as string
    const start: Point = first.split(',').map(Number) as Point
    const loop: Point[] = [start]
    let current = start

    for (;;) {
      const list = edges.get(key(current))
      if (!list || list.length === 0) break
      // At a vertex where two corners touch diagonally there are two ways out. The
      // first one recorded keeps the two regions separate instead of
      // stitching them into a single outline that goes through the void.
      const next = list.shift() as Point
      if (list.length === 0) edges.delete(key(current))
      current = next
      if (current[0] === start[0] && current[1] === start[1]) break
      loop.push(current)
    }
    if (loop.length >= 4) loops.push(loop)
  }
  return loops
}

/** Signed area — the sign says the direction, and the modulus filters small blobs. */
function signedArea(loop: Point[]): number {
  let sum = 0
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]
    const [x2, y2] = loop[(i + 1) % loop.length]
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/**
 * Douglas–Peucker: throws away the points that do not change the drawing.
 *
 * The outline comes from the pixel grid, so a straight 200px edge becomes 200
 * identical points in a line. Without this the SVG would be bigger than the PNG and there
 * would be no gain at all — this is the step that turns a staircase into a segment.
 */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3 || tolerance <= 0) return points

  const distance = (p: Point, a: Point, b: Point): number => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
    const cx = a[0] + Math.max(0, Math.min(1, t)) * dx
    const cy = a[1] + Math.max(0, Math.min(1, t)) * dy
    return Math.hypot(p[0] - cx, p[1] - cy)
  }

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    let worst = 0
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const d = distance(points[i], points[first], points[last])
      if (d > worst) {
        worst = d
        index = i
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

function toHex(r: number, g: number, b: number): string {
  const part = (v: number) => v.toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * Above this turn, the vertex is a real CORNER and stays angular.
 *
 * Without this distinction the rounding would treat everything the same and a square would
 * become a blob. With it, the curve of a circle smooths out and the corner of a rectangle
 * stays a corner.
 */
const CORNER_ANGLE = Math.PI / 3

/**
 * From the polygon to the curve.
 *
 * The outline comes from the pixel grid, so even simplified it is a
 * sequence of straight lines — and on a circle that shows up as facets as soon as the
 * person zooms in, which is exactly what they went after when vectorizing.
 *
 * The smoothing is the classic midpoint one: the curve passes through the middle of each
 * edge and uses the vertex as a control point. It adds no point at all — the
 * same file, with a curve instead of a facet — and it only enters where the turn is
 * smooth; a closed corner stays straight.
 */
function pathData(loops: Point[][]): string {
  const round = (n: number) => Math.round(n * 10) / 10
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

  return loops
    .map((loop) => {
      const n = loop.length
      if (n < 3) return ''

      const corner = loop.map((p, i) => {
        const prev = loop[(i - 1 + n) % n]
        const next = loop[(i + 1) % n]
        const a = Math.atan2(p[1] - prev[1], p[0] - prev[0])
        const b = Math.atan2(next[1] - p[1], next[0] - p[0])
        let turn = Math.abs(b - a)
        if (turn > Math.PI) turn = 2 * Math.PI - turn
        return turn > CORNER_ANGLE
      })

      const start = corner[0] ? loop[0] : mid(loop[n - 1], loop[0])
      let d = `M${round(start[0])} ${round(start[1])}`

      for (let i = 0; i < n; i++) {
        const p = loop[(i + 1) % n]
        if (corner[(i + 1) % n]) {
          d += `L${round(p[0])} ${round(p[1])}`
        } else {
          const end = mid(p, loop[(i + 2) % n])
          d += `Q${round(p[0])} ${round(p[1])} ${round(end[0])} ${round(end[1])}`
        }
      }
      return `${d}Z`
    })
    .filter(Boolean)
    .join('')
}

/**
 * Is `c` in the transition between `a` and `b`?
 *
 * It projects the color onto the segment that links the other two in LAB. It is a mixture when
 * it falls NEAR the line and in the MIDDLE of it — near one end means it is just
 * a variation of that color, and the previous step already handles that.
 */
function betweenness(
  c: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const abz = b[2] - a[2]
  const len = abx * abx + aby * aby + abz * abz
  if (len === 0) return false
  const t = ((c[0] - a[0]) * abx + (c[1] - a[1]) * aby + (c[2] - a[2]) * abz) / len
  if (t < 0.2 || t > 0.8) return false
  const px = a[0] + t * abx
  const py = a[1] + t * aby
  const pz = a[2] + t * abz
  return Math.hypot(c[0] - px, c[1] - py, c[2] - pz) < BLEND_LINE_DISTANCE
}

/**
 * Reduces the palette to the number ACTUALLY requested, in perceptual space.
 *
 * It exists for two reasons that add up. The first is that libvips' quantizer
 * jumps in powers of two: asking for 8 returns 16, and the parameter
 * would lie. The second is what shows up on screen — a blurred image (a
 * small drawing that was enlarged, a battered JPEG) has intermediate-color
 * edges, and the quantizer promotes them to colors of their own. Each one becomes
 * a GHOST outline layer next to the real stroke, and the drawing comes out with
 * a halo.
 *
 * The reduction always absorbs the color with the SMALLEST area into its nearest neighbor in
 * LAB. A transition band is, by definition, thin and sparse, so
 * it disappears inside the real color it came from — while the
 * dominant colors of the drawing, which have area, survive.
 */
function mergeColors(
  data: Buffer,
  channels: number,
  pixels: number,
  target: number,
): Map<string, string> {
  const count = new Map<string, number>()
  for (let i = 0; i < pixels; i++) {
    const at = i * channels
    const hex = toHex(data[at], data[at + 1], data[at + 2])
    count.set(hex, (count.get(hex) ?? 0) + 1)
  }

  const lab = new Map<string, [number, number, number]>()
  for (const hex of count.keys()) {
    lab.set(hex, labOf(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)))
  }

  // Everyone starts pointing at themselves; absorbing is rewriting the destination.
  const remap = new Map<string, string>()
  for (const hex of count.keys()) remap.set(hex, hex)
  const alive = new Map(count)

  const distance = (a: string, b: string) => {
    const x = lab.get(a) as [number, number, number]
    const y = lab.get(b) as [number, number, number]
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
  }
  const absorb = (smallest: string, destination: string) => {
    alive.set(destination, (alive.get(destination) as number) + (alive.get(smallest) as number))
    alive.delete(smallest)
    for (const [de, para] of remap) {
      if (para === smallest) remap.set(de, destination)
    }
  }

  // First step, and it is the one that matters most in a battered file: it merges what
  // is INDISTINGUISHABLE to the eye, without looking at size. A mistreated JPEG delivers the
  // same cream in five versions separated by less than a ΔE of nothing, and all of
  // them are large — they would survive an area-based merge and consume the whole
  // color budget, leaving the real drawing without a slot.
  for (;;) {
    let a = ''
    let b = ''
    let best = IDENTICAL_DELTA_E
    const colors = [...alive.keys()]
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const d = distance(colors[i], colors[j])
        if (d < best) {
          best = d
          a = colors[i]
          b = colors[j]
        }
      }
    }
    if (!a) break
    // The smaller is absorbed by the larger: whoever has area defines the final color.
    const smallest = (alive.get(a) as number) <= (alive.get(b) as number) ? a : b
    absorb(smallest, smallest === a ? b : a)
  }

  // Second step: gets rid of the EDGE ink — the mixture that the transition between
  // two tones creates and that draws a ghost outline next to each stroke.
  //
  // What identifies it is not being small, it is being BETWEEN two other colors. The
  // distinction matters: a legitimate accent (the red dot of a brand) is
  // small too, and an area threshold would erase it along with it. A mixture between
  // the navy of the stroke and the cream of the background falls, by construction, on top of
  // the segment that links the two — and no real color of the drawing falls there.
  for (;;) {
    let target = ''
    let destination = ''
    const colors = [...alive.keys()]
    for (const c of colors) {
      const area = alive.get(c) as number
      for (const a of colors) {
        for (const b of colors) {
          if (a === c || b === c || a === b) continue
          // It is only a mixture if the two ends weigh more than it.
          if ((alive.get(a) as number) <= area || (alive.get(b) as number) <= area) continue
          const position = betweenness(lab.get(c)!, lab.get(a)!, lab.get(b)!)
          if (!position) continue
          target = c
          destination = distance(c, a) <= distance(c, b) ? a : b
          break
        }
        if (target) break
      }
      if (target) break
    }
    if (!target || alive.size <= 2) break
    absorb(target, destination)
  }

  while (alive.size > target) {
    // The smallest area is the next to be absorbed.
    let smallest = ''
    let smallestN = Infinity
    for (const [hex, n] of alive) {
      if (n < smallestN) {
        smallestN = n
        smallest = hex
      }
    }

    let destination = ''
    let best = Infinity
    const a = lab.get(smallest) as [number, number, number]
    for (const hex of alive.keys()) {
      if (hex === smallest) continue
      const b = lab.get(hex) as [number, number, number]
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      if (d < best) {
        best = d
        destination = hex
      }
    }
    if (!destination) break
    absorb(smallest, destination)
  }
  return remap
}

/**
 * Traces looking for the number of colors the DRAWING asks for.
 *
 * More colors is not more fidelity when the file is bad: in a small illustration
 * that was enlarged, the extra colors are the mixture of the edges, and each
 * one becomes a ghost outline next to the stroke. The result comes out bigger,
 * slower and worse.
 *
 * Since this depends on the image and not on whoever asks, the default TRIES and measures: if
 * the tracing comes out heavy for the screen size, it repeats with fewer colors. At most
 * three attempts — the search cannot cost more than the work.
 */
export async function vectorizeImage(
  source: Buffer,
  options: VectorizeOptions = {},
): Promise<VectorizeResult> {
  if (options.colors === undefined || options.colors === 'auto') {
    let best: VectorizeResult | null = null
    for (const colors of [6, 4, 3]) {
      const attempt = await traceOnce(source, { ...options, colors })
      best = attempt
      // Budget by area: a clean drawing fits comfortably, and it is the excess that
      // reveals that the extra colors became edge instead of shape.
      if (attempt.points <= (attempt.width * attempt.height) / 150) break
    }
    return best as VectorizeResult
  }
  return traceOnce(source, options)
}

async function traceOnce(
  source: Buffer,
  options: VectorizeOptions,
): Promise<VectorizeResult> {
  const colorCount = Math.max(2, Math.min(32, typeof options.colors === 'number' ? options.colors : 6))
  const tolerance = options.tolerance ?? 1
  const warnings: string[] = []

  const meta = await sharp(source).metadata()
  const scale = Math.min(1, MAX_SIDE / Math.max(meta.width ?? 1, meta.height ?? 1))
  if (scale < 1) {
    warnings.push(
      `image downscaled to ${Math.round((meta.width ?? 0) * scale)}px before tracing — above that the result becomes too many paths to be useful`,
    )
  }

  // Quantizing is the step that makes the rest possible: without it, each pixel of a
  // gradient would be a "color" and each one would become its own shape.
  //
  // The palette requested from libvips is GENEROUS on purpose: its quantizer
  // in powers of two — asking for 5, 6, 8 or 12 returns 16 —, so the
  // number that arrives here would not be respected. What reduces to the requested value is
  // mergeColors below, and it is also what dissolves the transition bands that
  // draw a ghost outline next to each stroke.
  const prepared = sharp(source).flatten({ background: '#ffffff' })
  if (scale < 1) prepared.resize({ width: Math.round((meta.width ?? 1) * scale) })
  const quantized = await prepared.png({ palette: true, colours: 64, dither: 0 }).toBuffer()

  const { data, info } = await sharp(quantized).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const minArea = options.minArea ?? Math.max(4, (width * height) / 20_000)

  const remap = mergeColors(data, info.channels, width * height, colorCount)
  const palette = [...new Set(remap.values())]

  // Each pixel is reassigned from the ORIGINAL image, and not from the quantized one.
  //
  // The difference shows up at the edge. A transition pixel was labeled by the
  // quantizer as an intermediate color, and the merge sent that whole color
  // to one of the sides — all of its pixels together. Deciding pixel by
  // pixel, each one goes to the side it is actually closer to, and the
  // boundary falls where it really is instead of sliding half a stroke to the side.
  const original = await sharp(source)
    .flatten({ background: '#ffffff' })
    .resize({ width, height, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()

  const paletteLab = palette.map(
    (hex) =>
      labOf(
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ) as [number, number, number],
  )

  const label = new Int32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const at = i * 3
    const [l, a, b] = labOf(original[at], original[at + 1], original[at + 2])
    let best = 0
    let smallest = Infinity
    for (let k = 0; k < paletteLab.length; k++) {
      const p = paletteLab[k]
      const d = (l - p[0]) ** 2 + (a - p[1]) ** 2 + (b - p[2]) ** 2
      if (d < smallest) {
        smallest = d
        best = k
      }
    }
    label[i] = best
  }

  // Painting order: larger area behind. It has to be decided BEFORE the
  // masks, because each layer carries what comes on top of it.
  const areaByColor = new Int32Array(palette.length)
  for (let i = 0; i < width * height; i++) areaByColor[label[i]]++
  const order = palette
    .map((hex, k) => ({ hex, k, area: areaByColor[k] }))
    .filter((c) => c.area > 0)
    .sort((a, b) => b.area - a.area)

  // STACKED layers: each one includes everything that will be drawn over it.
  //
  // Tracing only their own pixels, two neighboring regions have the same
  // boundary traced twice — one on each side — and any divergence
  // between the two tracings opens a thread of background between them. Stacking, the
  // lower layer goes under the upper one and there is no seam to show.
  // divergir.
  // Position of each label in the stack, resolved once: looking inside the
  // pixel loop would scan the whole palette per pixel.
  const rankOf = new Int32Array(palette.length).fill(order.length)
  order.forEach((c, position) => {
    rankOf[c.k] = position
  })

  const byColor = new Map<string, Uint8Array>()
  for (let position = 0; position < order.length; position++) {
    const mask = new Uint8Array(width * height)
    for (let i = 0; i < width * height; i++) {
      if (rankOf[label[i]] >= position) mask[i] = 1
    }
    byColor.set(order[position].hex, mask)
  }

  // The color that dominates the EDGE is the background: it is the one to throw away for the
  // icon to come out cut out instead of inside a rectangle.
  const border = new Map<string, number>()
  const count = (i: number) => {
    const at = i * info.channels
    const hex = toHex(data[at], data[at + 1], data[at + 2])
    border.set(hex, (border.get(hex) ?? 0) + 1)
  }
  for (let x = 0; x < width; x++) {
    count(x)
    count((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    count(y * width)
    count(y * width + width - 1)
  }
  const background = [...border.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  const layers: { hex: string; d: string; area: number; points: number }[] = []
  // How much of the drawing is a blob too small to become a shape — measured in
  // AREA, not in quantity. The difference matters: an anti-aliased old logo
  // produces hundreds of one-pixel rings in the color mixture of the edges, and
  // counting heads would say it is not flat art. In area those crumbs
  // are negligible, whereas in a photo they ARE the image.
  let areaTotal = 0
  let discardedArea = 0

  for (const [hex, mask] of byColor) {
    if (options.dropBackground && hex === background) continue

    const rawContours = contours(mask, width, height).map((loop) => ({ loop, area: signedArea(loop) }))
    const large = rawContours.filter(({ area }) => Math.abs(area) >= minArea)
    for (const { area } of rawContours) areaTotal += Math.abs(area)
    for (const { area } of rawContours) {
      if (Math.abs(area) < minArea) discardedArea += Math.abs(area)
    }

    const loops = large
      .map(({ loop }) => simplify(loop, tolerance))
      .filter((loop) => loop.length >= 3)

    if (loops.length === 0) continue
    const area = loops.reduce((sum, loop) => sum + Math.abs(signedArea(loop)), 0)
    layers.push({
      hex,
      d: pathData(loops),
      area,
      points: loops.reduce((sum, loop) => sum + loop.length, 0),
    })
  }

  // Without reordering: the painting order was decided along with the stacking,
  // and each layer already contains what comes on top. Sorting by traced area here
  // would undo the stack — every stacked layer is large by construction.

  const paths = layers.length
  const points = layers.reduce((sum, c) => sum + c.points, 0)
  if (points > 20_000) {
    warnings.push(
      `${points} points across ${paths} layers — this looks like a photograph, and vectorizing a photograph produces a large, ugly file. A raster serves better here.`,
    )
  }
  // The other way the source does not hold up: instead of too many shapes, too many
  // crumbs. Noise and gradient break up into blobs of a few pixels, and what
  // is left is a drawing that does not look like the image.
  const lost = areaTotal > 0 ? discardedArea / areaTotal : 0
  if (lost > 0.3) {
    warnings.push(
      `${Math.round(lost * 100)}% of the drawing fell apart into blobs too small to become shapes — the image is not made of flat colors (photograph, gradient, texture). What came out will not look like it; a raster serves better here.`,
    )
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    layers
      .map((c) => `<path fill="${c.hex}" fill-rule="evenodd" d="${c.d}"/>`)
      .join('') +
    '</svg>'

  return {
    svg,
    width,
    height,
    usedColors: colorCount,
    colors: layers.map((c) => c.hex),
    paths,
    points,
    warnings,
  }
}
