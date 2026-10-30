import sharp from 'sharp'
import type { OverlayOptions, Sharp } from 'sharp'

/**
 * Image editing without a generation model.
 *
 * Everything here is pixel processing — resizing, cropping, adjusting tone,
 * compressing, cutting out the background. Nothing invents content, and that is precisely
 * why it serves everyday work: the result is predictable, it is fast, and
 * the photo that goes in is the same one that comes out.
 *
 * Pure bytes module (no Electron, no IO), to be testable — the same
 * separation as pdf-ops.ts.
 */

/** Sanity ceilings: a wrong request cannot turn into a GB of RAM. */
const MAX_PIXELS = 50_000_000
const MAX_DIMENSION = 20_000

export interface ImageInfo {
  format: string
  width: number
  height: number
  channels: number
  hasAlpha: boolean
  sizeBytes: number
  /**
   * Dominant color in #rrggbb — a background guess, not a measurement: sharp takes
   * it from a binned histogram, so what comes back is the bin center and may
   * differ a few points from the color that is there.
   */
  dominant: string
}

export async function imageInfo(source: Buffer): Promise<ImageInfo> {
  const meta = await sharp(source).metadata()
  const stats = await sharp(source).stats()
  return {
    format: meta.format ?? 'unknown',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    channels: meta.channels ?? 0,
    hasAlpha: meta.hasAlpha ?? false,
    sizeBytes: source.length,
    dominant: toHex(stats.dominant),
  }
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const part = (v: number) => Math.round(v).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/** `#rgb`, `#rrggbb` or `rgb(r,g,b)` → channels. Explicit error on the rest: a color
 *  the model wrote wrong cannot silently become black. */
export function parseColor(value: string): { r: number; g: number; b: number } {
  const text = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
    }
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(text)
  if (long) {
    return { r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16) }
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(text)
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  }
  throw new Error(`Invalid color: "${value}". Use #rrggbb, #rgb or rgb(r,g,b).`)
}

export interface RemoveBackgroundOptions {
  /** Background color. Absent = guessed from the image corners. */
  color?: string
  /**
   * 0-100, or 'auto' (default): how far the pixel may stray from the background color and
   * still be background. The 'auto' measures the spread of the image's own
   * frame, which is the only place where that answer exists.
   */
  tolerance?: number | 'auto'
  /** Removes the background color left on the subject's edge. On by default. */
  despill?: boolean
  /** Softening radius of the cut edge, in pixels. 0 = hard cut. */
  feather?: number
}

export interface RemoveBackgroundResult {
  png: Buffer
  /** Color treated as background — what the user needs to see when they missed the target. */
  color: string
  /** Fraction of the image that became transparent, 0–1. */
  removed: number
  /** ΔE threshold used — the number 'auto' chose, for whoever needs to
   *  repeat the cut tighter or looser from it. */
  limit: number
}

/**
 * Color in CIELAB, which is where the background comparison makes sense.
 *
 * In RGB, "distance" mixes brightness with color. On a lit green screen that
 * is fatal: the background of a real photo ranges from (100,164,77) in the corner to
 * (124,201,115) in the middle — an RGB distance of 56 — while from green to
 * skin it is 92. The variation of the BACKGROUND ITSELF takes up more than half of the way
 * to the subject, and no threshold separates the two.
 *
 * In LAB that variation is almost all luminosity (L), and the color (a,b) stays
 * practically still. Measuring with L weighing little, the same photo gives 4.7-7.5
 * inside the background against 47.9-60.9 on the subject: seven times the margin.
 *
 * It is the reason every chroma key compares COLOR and not BRIGHTNESS — the reflector that
 * lights up a corner of the screen does not make it less green.
 */
const SRGB_TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  SRGB_TO_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function labOf(r: number, g: number, b: number): [number, number, number] {
  const R = SRGB_TO_LINEAR[r]
  const G = SRGB_TO_LINEAR[g]
  const B = SRGB_TO_LINEAR[b]
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/**
 * Weight of luminosity in the distance.
 *
 * Zero would be classic chroma key, but then black and white become "the same color"
 * as any gray background. A quarter keeps the brightness difference perceptible without
 * letting the reflector's gradient decide the cut.
 */
const LIGHTNESS_WEIGHT = 0.25

/** The 0-100 scale of the tolerance, in ΔE. 100 covers completely
 *  different colors; the useful range for a flat background is between 10 and 30. */
const TOLERANCE_TO_DELTA_E = 0.6

/**
 * Cuts out the background by flooding from the EDGES.
 *
 * The difference from a simple chroma key is there: the chroma key erases every similar
 * color, wherever it is, and opens holes in the middle of the subject — the person's
 * white shirt disappears along with the white wall. Spreading from the
 * edge only reaches what is CONNECTED to the background, so the white surrounded by
 * subject stays opaque.
 *
 * What this does well: flat or almost flat background — product photo, studio
 * portrait, logo, screenshot. What it does not do: separate hair from a
 * busy scene, which is exactly where a segmentation model comes in. The
 * `removed` returned serves to recognize the second case without having to look.
 */
export async function removeBackground(
  source: Buffer,
  options: RemoveBackgroundOptions = {},
): Promise<RemoveBackgroundResult> {
  const { data, info } = await sharp(source)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height } = info
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `Image too large to cut out the background (${width}x${height}). Resize it first.`,
    )
  }

  const background = options.color ? parseColor(options.color) : sampleBorder(data, width, height)
  const backgroundLab = labOf(background.r, background.g, background.b)

  // Distance of each pixel to the background, computed once. The
  // flood visits the same pixel several times (once per neighbor), and
  // converting to LAB inside the loop would redo the same cube root for no reason.
  const distance = new Float32Array(width * height)
  for (let i = 0; i < distance.length; i++) {
    const at = i * 4
    const [l, a, b] = labOf(data[at], data[at + 1], data[at + 2])
    const dl = l - backgroundLab[0]
    const da = a - backgroundLab[1]
    const db = b - backgroundLab[2]
    distance[i] = Math.sqrt(LIGHTNESS_WEIGHT * dl * dl + da * da + db * db)
  }

  const limit =
    options.tolerance === undefined || options.tolerance === 'auto'
      ? autoLimit(distance, width, height)
      : Math.min(100, Math.max(0, options.tolerance)) * TOLERANCE_TO_DELTA_E

  // Explicit queue, and not recursion: an image of a few megapixels of flat
  // background would blow the call stack on the first real photo.
  const seen = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0

  const matches = (index: number): boolean => distance[index] <= limit

  const push = (index: number) => {
    if (seen[index]) return
    seen[index] = 1
    if (matches(index)) queue[tail++] = index
  }

  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }

  let removed = 0
  while (head < tail) {
    const index = queue[head++]
    data[index * 4 + 3] = 0
    removed++
    const x = index % width
    const y = (index / width) | 0
    if (x > 0) push(index - 1)
    if (x < width - 1) push(index + 1)
    if (y > 0) push(index - width)
    if (y < height - 1) push(index + width)
  }

  // Decontaminate BEFORE softening: the spill lives in the pixels that are still
  // opaque, and after the feather part of them has already become transition.
  if (options.despill !== false) despill(data, width, height, background)

  const feather = Math.min(20, Math.max(0, options.feather ?? 0))
  if (feather > 0) await softenAlpha(data, width, height, feather)

  const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { png, color: toHex(background), removed: removed / (width * height), limit }
}

/**
 * Background color from the WHOLE FRAME, not from the four corners.
 *
 * Four pixels are too small a sample: in a photo where the subject touches the
 * edge, two corners may already fall on it. The whole frame dilutes that,
 * and the per-channel median discards whatever is subject instead of averaging with
 * it — a color that does not exist in the image would be the worst possible guess.
 */
function sampleBorder(data: Buffer, width: number, height: number) {
  const r: number[] = []
  const g: number[] = []
  const b: number[] = []
  const take = (index: number) => {
    const at = index * 4
    r.push(data[at])
    g.push(data[at + 1])
    b.push(data[at + 2])
  }
  for (let x = 0; x < width; x++) {
    take(x)
    take((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    take(y * width)
    take(y * width + width - 1)
  }
  const median = (values: number[]) => {
    values.sort((a, z) => a - z)
    return values[values.length >> 1]
  }
  return { r: median(r), g: median(g), b: median(b) }
}

/**
 * Tolerance measured on the image itself, instead of guessed.
 *
 * The caller has no way of knowing the right number: it depends on how uniform the
 * background of that photo is. The frame, on the other hand, is almost all background — so its
 * spread IS the answer. A high percentile is taken (not the maximum, which
 * would be the piece of subject touching the edge) and a margin is opened.
 *
 * Erring on the tight side is the safe side: background is left, which is seen right away and
 * corrected by repeating with a larger tolerance. Erring on the loose side eats the
 * subject, and that has no way back.
 */
const AUTO_PERCENTILE = 0.8
const AUTO_MARGIN = 2.5
const AUTO_FLOOR = 8
const AUTO_CEILING = 34

function autoLimit(distance: Float32Array, width: number, height: number): number {
  const border: number[] = []
  for (let x = 0; x < width; x++) {
    border.push(distance[x], distance[(height - 1) * width + x])
  }
  for (let y = 0; y < height; y++) {
    border.push(distance[y * width], distance[y * width + width - 1])
  }
  border.sort((a, b) => a - b)
  const spread = border[Math.floor(border.length * AUTO_PERCENTILE)]
  return Math.min(AUTO_CEILING, Math.max(AUTO_FLOOR, spread * AUTO_MARGIN))
}

/**
 * Removes the background color that stuck to the subject's edge.
 *
 * A perfect cut still leaves a halo: the transition pixels are a MIXTURE
 * of subject and background, so next to a green screen the person's outline becomes
 * greenish. It is what makes a cut look cut out.
 *
 * The correction is the classic chroma key one: in the channel that dominates the background
 * color, the pixel cannot exceed the average of the other two. Applied ONLY near the cut —
 * a green tie in the middle of the chest is not spill, and limiting the whole
 * image would erase it.
 */
const DESPILL_RADIUS = 2

function despill(
  data: Buffer,
  width: number,
  height: number,
  background: { r: number; g: number; b: number },
) {
  const channels = [background.r, background.g, background.b]
  const dominant = channels.indexOf(Math.max(...channels))
  // A gray or white background has no real dominant channel: there is no hue
  // to spill, and "correcting" would only take color away from those who have it.
  const rival = (Math.max(...channels) - Math.min(...channels)) / 255
  if (rival < 0.08) return

  let ring: number[] = []
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] === 0) continue
    const x = i % width
    const y = (i / width) | 0
    const touches =
      (x > 0 && data[(i - 1) * 4 + 3] === 0) ||
      (x < width - 1 && data[(i + 1) * 4 + 3] === 0) ||
      (y > 0 && data[(i - width) * 4 + 3] === 0) ||
      (y < height - 1 && data[(i + width) * 4 + 3] === 0)
    if (touches) ring.push(i)
  }

  const treated = new Uint8Array(width * height)
  for (let step = 0; step < DESPILL_RADIUS && ring.length > 0; step++) {
    const next: number[] = []
    for (const i of ring) {
      if (treated[i]) continue
      treated[i] = 1
      const at = i * 4
      const others = [0, 1, 2].filter((c) => c !== dominant)
      const cap = (data[at + others[0]] + data[at + others[1]]) / 2
      if (data[at + dominant] > cap) data[at + dominant] = Math.round(cap)
      const x = i % width
      const y = (i / width) | 0
      if (x > 0) next.push(i - 1)
      if (x < width - 1) next.push(i + 1)
      if (y > 0) next.push(i - width)
      if (y < height - 1) next.push(i + width)
    }
    ring = next.filter((i) => !treated[i] && data[i * 4 + 3] !== 0)
  }
}

/**
 * Blurs ONLY the alpha channel, so the cut edge does not come out jagged.
 *
 * The cut by tolerance is binary: either the pixel is background or it is not. In a photo,
 * the real transition occupies one or two mixed pixels, and the hard cut leaves
 * on them an outline of the old background color. Softening the alpha dissolves that
 * outline without touching the subject's colors.
 */
async function softenAlpha(data: Buffer, width: number, height: number, radius: number) {
  const alpha = Buffer.allocUnsafe(width * height)
  for (let i = 0; i < width * height; i++) alpha[i] = data[i * 4 + 3]
  // The blur over a 1-channel raw RETURNS 3. Reading the result as if it were a
  // single channel advances only a third of what is needed per pixel: the alpha comes out
  // compressed horizontally and striped, which was the banding artifact in the first cut
  // that this code produced. That is why the step comes from what sharp reports, and not
  // from what was requested.
  const { data: blurred, info } = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(radius)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const stride = info.channels
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = blurred[i * stride]
}

/**
 * Text written over the image.
 *
 * The difficulty of writing on a PHOTO is not drawing the letter — it is keeping it
 * legible over a background that changes from light to dark in the middle of the word.
 * That is why the default is white with a dark outline, which reads both in the
 * sky and in the shadow, and there is the band behind it for when not even that suffices.
 */
export interface TextOverlay {
  content: string
  /** Where to anchor. The model does not know the photo's dimensions; this keeps it
   *  from having to know. */
  position?:
    | 'top-left'
    | 'top'
    | 'top-right'
    | 'left'
    | 'center'
    | 'right'
    | 'bottom-left'
    | 'bottom'
    | 'bottom-right'
  /** Exact position in pixels, when the anchor does not serve. Overrides `position`. */
  x?: number
  y?: number
  /** Font height in pixels. Absent = proportional to the image, which is what
   *  keeps the caption with the same weight in a thumbnail and in a poster. */
  size?: number
  color?: string
  /** Outline. `null` turns it off — it only makes sense over a guaranteed flat background. */
  outline?: string | null
  /** Band behind the text, for a very noisy photo. */
  background?: string
  backgroundOpacity?: number
  font?: string
  align?: 'left' | 'center' | 'right'
  /** Maximum width before wrapping. Absent = 90% of the image. */
  maxWidth?: number
  opacity?: number
}

export interface ImageEdit {
  resize?: {
    width?: number
    height?: number
    fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
    /** Allows growing beyond the original size. By default it does not — enlarging a
     *  small file only produces a bigger blur. */
    enlarge?: boolean
    /** Fill color when `contain` leaves space. */
    background?: string
  }
  crop?: { left: number; top: number; width: number; height: number }
  /** Trims the uniform color frame around it (scan, screenshot with a bar). */
  trim?: { threshold?: number }
  rotate?: number
  flip?: boolean
  flop?: boolean
  removeBackground?: RemoveBackgroundOptions
  grayscale?: boolean
  negate?: boolean
  /** 1 = neutral. 1.2 brightens 20%, 0.8 darkens 20%. */
  brightness?: number
  /** 1 = neutral, 0 = gray, >1 saturates. */
  saturation?: number
  /** Hue wheel rotation, in degrees. */
  hue?: number
  /** 1 = neutral. Applied around mid gray. */
  contrast?: number
  gamma?: number
  /** Stretches the histogram to use the whole range — rescues a washed-out photo. */
  normalize?: boolean
  blur?: number
  sharpen?: boolean
  tint?: string
  /** Flattens the transparency over this color (mandatory when turning into JPEG). */
  flatten?: string
  /** Text written on top. Applied after the size and the color: the caption is an
   *  annotation, it is not part of the photo being adjusted. */
  text?: TextOverlay[]
  format?: 'png' | 'jpeg' | 'webp'
  /** 1–100. Ignored in PNG, which is lossless. */
  quality?: number
  /** Byte ceiling: reduces quality and, if needed, dimensions, until it fits. */
  maxBytes?: number
}

export interface EditResult {
  bytes: Buffer
  format: string
  width: number
  height: number
  /** Filled when there was removeBackground — the color treated as background. */
  backgroundColor?: string
  /** Cropped fraction, when there was removeBackground. */
  backgroundRemoved?: number
  /** Threshold used in the cut, on the 0-100 scale of the tolerance. It is the starting
   *  point for correcting: without it, adjusting would be guessing again. */
  backgroundLimit?: number
  /** Steps that maxBytes had to take; empty when it fit on the first try. */
  compression?: string
}

const DEFAULT_FONT = 'Segoe UI, DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif'
/** Font height as a fraction of the shorter side — keeps the same visual weight in a
 *  thumbnail and in a poster. */
const TEXT_SIZE_RATIO = 0.07
const LINE_HEIGHT = 1.22
/** Outline thickness relative to the font. */
const OUTLINE_RATIO = 0.16

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Real width of a line, by rendering and measuring.
 *
 * It cannot be estimated: at the same 40px size, ten "M" take 353px and ten "i"
 * take 93 — almost four times the difference. An average constant makes the
 * caption with many capitals leak outside the photo, which is the mistake
 * nobody forgives in a finished image.
 */
async function measureText(text: string, size: number, font: string): Promise<number> {
  if (!text.trim()) return 0
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(
    64,
    Math.ceil(text.length * size),
  )}" height="${Math.ceil(size * 2)}"><text x="0" y="${Math.ceil(
    size * 1.4,
  )}" font-family="${font}" font-size="${size}" fill="#000">${escapeXml(text)}</text></svg>`
  try {
    const { info } = await sharp(Buffer.from(svg))
      .png()
      .trim()
      .toBuffer({ resolveWithObject: true })
    return info.width
  } catch {
    // Nothing drawn (only spaces, or no installed font): trim does not find
    // what to crop and complains. Zero is the honest answer.
    return 0
  }
}

/**
 * Breaks the text into lines that fit the width.
 *
 * It measures the whole sentence ONCE to calibrate the average character width
 * of that specific text, and only then breaks it. It is the middle ground between estimating
 * with a constant (wrong by four) and measuring every attempt (one rendering
 * per word): the mix of letters in a caption is stable along it,
 * so the value calibrated on it holds for its own lines.
 */
async function wrapText(
  content: string,
  size: number,
  font: string,
  maxWidth: number,
): Promise<string[]> {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (!flat) return []

  const measured = await measureText(flat, size, font)
  const perChar = measured > 0 ? measured / flat.length : size * 0.5
  const limit = Math.max(1, Math.floor(maxWidth / perChar))

  const lines: string[] = []
  for (const paragraph of content.split('\n')) {
    const trimmed = paragraph.replace(/\s+/g, ' ').trim()
    if (!trimmed) {
      // A blank line written on purpose is spacing requested by the author.
      lines.push('')
      continue
    }
    let current = ''
    for (const word of trimmed.split(' ')) {
      const candidate = current ? `${current} ${word}` : word
      if (candidate.length <= limit || !current) current = candidate
      else {
        lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

/**
 * Writes the texts over the image.
 *
 * It draws in SVG and composites, because that is what gives a real outline
 * (`paint-order`) — and the outline is what makes the caption survive a photo
 * that goes from bright sky to dark shadow within the same word. Writing in
 * pure white works until the first image with a light background.
 */
async function drawText(image: Buffer, overlays: TextOverlay[]): Promise<Buffer> {
  const meta = await sharp(image).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) return image

  const layers: OverlayOptions[] = []

  for (const overlay of overlays) {
    if (!overlay.content?.trim()) continue
    const font = overlay.font ? `${overlay.font}, ${DEFAULT_FONT}` : DEFAULT_FONT
    const size = Math.max(8, Math.round(overlay.size ?? Math.min(width, height) * TEXT_SIZE_RATIO))
    const margin = Math.round(size * 0.6)
    const maxWidth = Math.max(size, Math.min(overlay.maxWidth ?? Math.round(width * 0.9), width - margin * 2))

    const lines = await wrapText(overlay.content, size, font, maxWidth)
    if (lines.length === 0) continue

    // Checks the real longest line and shrinks if it still overflowed: the
    // calibration is good, not exact, and leaking outside the photo is not acceptable.
    const widths = await Promise.all(lines.map((line) => measureText(line, size, font)))
    const widest = Math.max(1, ...widths)
    const scale = widest > maxWidth ? maxWidth / widest : 1
    const finalSize = Math.max(8, Math.floor(size * scale))
    const lineHeight = Math.round(finalSize * LINE_HEIGHT)
    const blockWidth = Math.ceil(widest * scale)
    const blockHeight = lineHeight * lines.length

    const position = overlay.position ?? 'bottom'
    const left = position.includes('left')
      ? margin
      : position.includes('right')
        ? width - blockWidth - margin
        : Math.round((width - blockWidth) / 2)
    const top = position.startsWith('top')
      ? margin
      : position.startsWith('bottom')
        ? height - blockHeight - margin
        : Math.round((height - blockHeight) / 2)

    const align =
      overlay.align ??
      (position.includes('left') ? 'left' : position.includes('right') ? 'right' : 'center')
    const textX = align === 'left' ? 0 : align === 'right' ? blockWidth : blockWidth / 2
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle'

    const color = overlay.color ?? '#ffffff'
    const outline = overlay.outline === null ? null : (overlay.outline ?? '#000000')
    const strokeWidth = Math.max(1, Math.round(finalSize * OUTLINE_RATIO))
    // The outline grows to BOTH sides of the letter, so half of it falls
    // outside the measured block. Without this margin the edge comes out cut.
    const pad = strokeWidth + 2

    const band = overlay.background
      ? `<rect x="0" y="0" width="${blockWidth + pad * 2}" height="${
          blockHeight + pad * 2
        }" rx="${Math.round(finalSize * 0.2)}" fill="${overlay.background}" fill-opacity="${
          overlay.backgroundOpacity ?? 0.55
        }"/>`
      : ''

    const rows = lines
      .map((line, i) => {
        const y = pad + Math.round(lineHeight * (i + 0.8))
        const stroke = outline
          ? ` stroke="${outline}" stroke-width="${strokeWidth}" paint-order="stroke fill" stroke-linejoin="round"`
          : ''
        return `<text x="${pad + textX}" y="${y}" text-anchor="${anchor}" font-family="${font}" font-size="${finalSize}" font-weight="600" fill="${color}"${stroke}>${escapeXml(
          line,
        )}</text>`
      })
      .join('')

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${blockWidth + pad * 2}" height="${
      blockHeight + pad * 2
    }">${band}<g opacity="${overlay.opacity ?? 1}">${rows}</g></svg>`

    layers.push({
      input: Buffer.from(svg),
      // Pinned inside the image: an anchor requested outside it would put the text where
      // nobody would see it, and composite refuses a negative offset.
      left: Math.max(0, Math.min(width - 1, (overlay.x ?? left) - pad)),
      top: Math.max(0, Math.min(height - 1, (overlay.y ?? top) - pad)),
    })
  }

  if (layers.length === 0) return image
  return sharp(image).composite(layers).png().toBuffer()
}

/**
 * Applies the requested operations, in this fixed order:
 *
 *   EXIF orientation → crop → frame → rotate/mirror → background → size →
 *   color → text → flatten → encoding
 *
 * The order is not arbitrary. The EXIF orientation comes first because the
 * crop coordinates are those of the image as the person sees it, not as the
 * bytes are stored. The background comes out before resizing because reducing
 * first mixes subject and background at the edge and spoils the cut. And the color comes
 * after the size only because it is cheaper to adjust fewer pixels.
 */
export async function editImage(source: Buffer, edit: ImageEdit): Promise<EditResult> {
  let working = source
  let backgroundColor: string | undefined
  let backgroundRemoved: number | undefined
  let backgroundLimit: number | undefined

  // The geometry stage materializes an intermediate PNG so as not to lose
  // transparency along the way. In a 12MP photo that is expensive, so it only runs
  // when there is in fact something to do — a simple "shrink this image" does not pay for it.
  const needsGeometry = Boolean(
    edit.crop || edit.trim || edit.rotate || edit.flip || edit.flop,
  )

  if (edit.removeBackground) {
    const cut = await removeBackground(
      needsGeometry ? await applyGeometry(source, edit) : source,
      edit.removeBackground,
    )
    working = cut.png
    backgroundColor = cut.color
    backgroundRemoved = cut.removed
    backgroundLimit = cut.limit / TOLERANCE_TO_DELTA_E
  } else if (needsGeometry) {
    working = await applyGeometry(source, edit)
  }

  let pipeline = sharp(working)
  // When nothing above touched the pixels, the EXIF orientation has not yet been
  // applied — and without it the phone photo comes out sideways.
  if (!needsGeometry && !edit.removeBackground) pipeline = pipeline.rotate()

  if (edit.resize && (edit.resize.width || edit.resize.height)) {
    const { width, height, fit, enlarge, background } = edit.resize
    if ((width ?? 0) > MAX_DIMENSION || (height ?? 0) > MAX_DIMENSION) {
      throw new Error(`Requested size above the ${MAX_DIMENSION}px limit.`)
    }
    pipeline = pipeline.resize({
      width: width || undefined,
      height: height || undefined,
      fit: fit ?? 'inside',
      withoutEnlargement: !enlarge,
      background: background ? { ...parseColor(background), alpha: 1 } : undefined,
    })
  }

  pipeline = applyColor(pipeline, edit)

  // Text last among the pixels: the caption is an annotation, it is not part of the
  // photo. Writing it before the resize would leave it blurred along with the image, and
  // before the black and white it would paint it gray along with it.
  if (edit.text && edit.text.length > 0) {
    pipeline = sharp(await drawText(await pipeline.toBuffer(), edit.text))
  }

  if (edit.flatten) pipeline = pipeline.flatten({ background: parseColor(edit.flatten) })

  return encode(pipeline, edit, { backgroundColor, backgroundRemoved, backgroundLimit })
}

/** Orientation, crop, frame and rotation — everything that touches the pixel grid. */
async function applyGeometry(source: Buffer, edit: ImageEdit): Promise<Buffer> {
  let pipeline = sharp(source).rotate()

  if (edit.crop) {
    const { left, top, width, height } = edit.crop
    if (width <= 0 || height <= 0) throw new Error('The crop needs positive width and height.')
    // sharp's extract refuses a rectangle that goes past the edge; its error
    // talks about "bad extract area", which does not tell the model what to fix.
    const meta = await sharp(source).rotate().metadata()
    const limitX = meta.width ?? 0
    const limitY = meta.height ?? 0
    if (left < 0 || top < 0 || left + width > limitX || top + height > limitY) {
      throw new Error(
        `The crop (${left},${top} ${width}x${height}) falls outside the image, which is ${limitX}x${limitY}.`,
      )
    }
    pipeline = pipeline.extract({ left, top, width, height })
  }

  if (edit.trim) pipeline = pipeline.trim({ threshold: edit.trim.threshold ?? 10 })
  if (edit.rotate) pipeline = pipeline.rotate(edit.rotate, { background: '#00000000' })
  if (edit.flip) pipeline = pipeline.flip()
  if (edit.flop) pipeline = pipeline.flop()

  // Materializes it as PNG so as not to lose transparency between stages.
  return pipeline.png().toBuffer()
}

function applyColor(pipeline: Sharp, edit: ImageEdit): Sharp {
  let out = pipeline
  // The keys go in one by one: modulate refuses `{ brightness: undefined }`
  // with a parameter error, so asking only for saturation would break the whole adjustment.
  const modulate: { brightness?: number; saturation?: number; hue?: number } = {}
  if (edit.brightness !== undefined) modulate.brightness = edit.brightness
  // Saturation 0 is the legitimate request "remove all color", but modulate requires a
  // number above zero — what does that in sharp is grayscale.
  if (edit.saturation !== undefined && edit.saturation > 0) modulate.saturation = edit.saturation
  if (edit.hue !== undefined) modulate.hue = edit.hue
  if (Object.keys(modulate).length > 0) out = out.modulate(modulate)
  if (edit.saturation === 0) out = out.grayscale()
  // linear(a, b) makes output = a*input + b. To rotate around mid gray
  // (and not black, which would only brighten everything), the offset follows the gain.
  if (edit.contrast !== undefined) out = out.linear(edit.contrast, 128 * (1 - edit.contrast))
  if (edit.gamma !== undefined) out = out.gamma(edit.gamma)
  if (edit.grayscale) out = out.grayscale()
  if (edit.negate) out = out.negate({ alpha: false })
  if (edit.normalize) out = out.normalise()
  if (edit.tint) out = out.tint(parseColor(edit.tint))
  if (edit.blur) out = out.blur(edit.blur)
  if (edit.sharpen) out = out.sharpen()
  return out
}

/** Qualities tried when chasing a byte ceiling, from best to worst. */
const QUALITY_STEPS = [90, 80, 70, 60, 50, 40, 30]
/** How many times it may shrink after exhausting the quality. */
const MAX_SHRINKS = 6

async function encode(
  pipeline: Sharp,
  edit: ImageEdit,
  extra: { backgroundColor?: string; backgroundRemoved?: number; backgroundLimit?: number },
): Promise<EditResult> {
  // PNG when the background came out and nobody requested a format: saving transparency in
  // JPEG would lose it entirely, without warning.
  const format = edit.format ?? (extra.backgroundRemoved !== undefined ? 'png' : undefined)
  const base = await pipeline.toBuffer()

  const write = async (quality: number, scale: number): Promise<Buffer> => {
    let step = sharp(base)
    if (scale < 1) {
      const meta = await sharp(base).metadata()
      step = step.resize({
        width: Math.max(1, Math.round((meta.width ?? 1) * scale)),
        withoutEnlargement: true,
      })
    }
    if (format === 'jpeg') return step.jpeg({ quality }).toBuffer()
    if (format === 'webp') return step.webp({ quality }).toBuffer()
    if (format === 'png') return step.png().toBuffer()
    return step.toBuffer()
  }

  const quality = edit.quality ?? 82
  let bytes = await write(quality, 1)
  let compression: string | undefined

  if (edit.maxBytes && bytes.length > edit.maxBytes) {
    const tried: string[] = [`${format ?? 'original'} q${quality}`]
    // PNG has no lossy quality: insisting on the steps below would only waste
    // time, so its reduction is all by dimension.
    if (format !== 'png') {
      for (const step of QUALITY_STEPS) {
        if (step >= quality) continue
        bytes = await write(step, 1)
        tried.push(`q${step}`)
        if (bytes.length <= edit.maxBytes) break
      }
    }
    let scale = 1
    for (let i = 0; i < MAX_SHRINKS && bytes.length > edit.maxBytes; i++) {
      scale *= 0.8
      bytes = await write(format === 'png' ? quality : 60, scale)
      tried.push(`${Math.round(scale * 100)}% of the size`)
    }
    compression = tried.join(' → ')
  }

  const meta = await sharp(bytes).metadata()
  return {
    bytes,
    format: meta.format ?? 'unknown',
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    backgroundColor: extra.backgroundColor,
    backgroundRemoved: extra.backgroundRemoved,
    backgroundLimit: extra.backgroundLimit,
    compression,
  }
}
