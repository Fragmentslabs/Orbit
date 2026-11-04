/**
 * Contact sheets of ANYTHING that plays in the panel browser: a video (even one streamed from a
 * site, with nothing downloaded), a CSS/canvas/Lottie animation, a Motion piece, an app demo.
 * The result is a grid of frames with the time written on each — images only, no waveform, no words.
 *
 * Two ways to get the frames, because "a frame at time t" is only well defined for some pages:
 *  - video: the <video> is paused, sought, and each frame is drawn into a canvas INSIDE the page and
 *    exported — exact times, native resolution, no screenshot (so no window size to fight);
 *  - seek: a snippet the caller supplies puts the page at time t (orbitMotion.seek, a Lottie
 *    goToAndStop, document.getAnimations…) and the panel is screenshotted.
 * The grid itself is composed here, in the main process, the same way for both.
 *
 * What is here is pure or self-contained so it can be tested without Electron: the planning of the
 * instants, the page scripts (plain strings) and the composer (canvas).
 */

export const MAX_FRAMES = 120
export const DEFAULT_PER_SHEET = 24
export const DEFAULT_COLS = 4
export const DEFAULT_TILE = 240

export interface SampleOptions {
  from?: number
  to?: number
  /** Seconds between frames. */
  step?: number
  /** Number of frames, evenly spaced from..to (inclusive of both ends). Wins over step. */
  count?: number
  /** Length of the source when it is known (a video): the default for `to`. */
  duration?: number
}

/**
 * The instants (seconds) to sample. Throws with a reason the agent can act on.
 * Defaults: from 0, to the duration, and when neither step nor count is given, ~24 frames.
 */
export function sampleTimes(o: SampleOptions): number[] {
  const from = o.from ?? 0
  const to = o.to ?? o.duration
  if (to === undefined || !isFinite(to)) throw new Error('give `to` (seconds) — this source has no duration of its own')
  if (!(from >= 0)) throw new Error('`from` must be >= 0')
  if (!(to > from)) throw new Error(`\`to\` (${to}) must be after \`from\` (${from})`)
  let times: number[]
  if (o.count !== undefined) {
    const n = Math.max(1, Math.round(o.count))
    times = n === 1 ? [from] : Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1))
  } else {
    const step = o.step ?? (to - from) / (DEFAULT_PER_SHEET - 1)
    if (!(step > 0)) throw new Error('`step` must be > 0')
    times = []
    for (let t = from; t <= to + 1e-9; t += step) times.push(Math.round(t * 1000) / 1000)
  }
  if (times.length > MAX_FRAMES) {
    throw new Error(`${times.length} frames asked (max ${MAX_FRAMES}) — widen the step, narrow from/to, or ask for a section at a time`)
  }
  return times.map((t) => Math.round(t * 1000) / 1000)
}

/** Splits the instants into sheets of at most `perSheet` frames. */
export function planSheets(times: number[], perSheet = DEFAULT_PER_SHEET): number[][] {
  const size = Math.max(1, Math.floor(perSheet))
  const out: number[][] = []
  for (let i = 0; i < times.length; i += size) out.push(times.slice(i, i + size))
  return out
}

/** "3.20 s" — the label drawn on a tile. */
export function timeLabel(t: number): string {
  return `${t.toFixed(2)}s`
}

// --------------------------------------------------------------------------------------------
// Page scripts. Strings (no TS helpers can be serialised safely): each is an async IIFE that
// returns a plain object. Parameters go in as JSON.

/** Finds the <video> to read: the selector, or the largest one on screen that has dimensions. */
const PICK_VIDEO = `
  const pick = () => {
    if (P.selector) {
      const el = document.querySelector(P.selector)
      if (!el) return null
      return el.tagName === 'VIDEO' ? el : (el.querySelector ? el.querySelector('video') : null)
    }
    const vids = Array.prototype.slice.call(document.querySelectorAll('video')).filter(function (v) {
      return v.readyState > 0 && isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0
    })
    let best = null, area = -1
    for (const v of vids) {
      const r = v.getBoundingClientRect()
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
      if (w * h > area) { area = w * h; best = v }
    }
    return best
  }
`

/** What is in the page: is there a video, how long, how big, is it playing. No side effects. */
export function videoProbeScript(selector?: string): string {
  return `(async () => {
  const P = ${JSON.stringify({ selector: selector ?? null })}
  ${PICK_VIDEO}
  const v = pick()
  if (!v) return { found: false, videos: document.querySelectorAll('video').length }
  return {
    found: true,
    duration: v.duration,
    width: v.videoWidth,
    height: v.videoHeight,
    paused: v.paused,
    at: v.currentTime,
    src: String(v.currentSrc || '').split(':')[0],
    videos: document.querySelectorAll('video').length,
  }
})()`
}

/**
 * Seeks the video to each time and draws the frame into a canvas of `tile` px, returning JPEG data
 * URLs. The video is put back as it was (time and play state). If the canvas is tainted (a
 * cross-origin video without CORS) it says so instead of returning blanks.
 */
export function videoCaptureScript(o: { selector?: string; times: number[]; tile: number; quality?: number }): string {
  const params = { selector: o.selector ?? null, times: o.times, tile: Math.round(o.tile), quality: o.quality ?? 0.82 }
  return `(async () => {
  const P = ${JSON.stringify(params)}
  ${PICK_VIDEO}
  const v = pick()
  if (!v) return { error: 'no-video' }
  const duration = v.duration
  const wasPaused = v.paused
  const was = v.currentTime
  v.pause()
  const th = Math.max(1, Math.round(P.tile * v.videoHeight / v.videoWidth))
  const canvas = document.createElement('canvas')
  canvas.width = P.tile
  canvas.height = th
  const g = canvas.getContext('2d')
  const seek = function (t) {
    return new Promise(function (resolve) {
      const target = Math.min(Math.max(0, t), Math.max(0, duration - 0.04))
      let done = false
      let timer = 0
      const finish = function () {
        if (done) return
        done = true
        clearTimeout(timer)
        v.removeEventListener('seeked', onSeeked)
        resolve()
      }
      const onSeeked = function () {
        if (typeof v.requestVideoFrameCallback === 'function') {
          v.requestVideoFrameCallback(function () { finish() })
          setTimeout(finish, 250)
        } else setTimeout(finish, 90)
      }
      timer = setTimeout(finish, 5000)
      if (Math.abs(v.currentTime - target) < 0.001) { setTimeout(finish, 60); return }
      v.addEventListener('seeked', onSeeked)
      v.currentTime = target
    })
  }
  const frames = []
  const actual = []
  let error = null
  try {
    for (const t of P.times) {
      await seek(t)
      g.drawImage(v, 0, 0, P.tile, th)
      frames.push(canvas.toDataURL('image/jpeg', P.quality))
      actual.push(Math.round(v.currentTime * 1000) / 1000)
    }
  } catch (e) {
    error = String((e && e.message) || e)
  }
  try { v.currentTime = was; if (!wasPaused) v.play() } catch (e) {}
  if (error) return { error: /tainted|insecure|security/i.test(error) ? 'tainted' : 'draw', message: error, frames: frames, actual: actual }
  return { frames: frames, actual: actual, duration: duration, width: v.videoWidth, height: v.videoHeight }
})()`
}

/**
 * Runs the caller's snippet with `t` (seconds) and `i` (index) in scope, awaiting it: the page goes to
 * time t. Example bodies: `await window.orbitMotion.seek(Math.round(t * 30))`,
 * `anim.goToAndStop(t * 1000)`, `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t * 1000 })`.
 */
export function seekScript(code: string, t: number, i: number): string {
  return `(async (t, i) => {\n${code}\n})(${JSON.stringify(t)}, ${JSON.stringify(i)})`
}

// --------------------------------------------------------------------------------------------
// Composer

export interface SheetOptions {
  cols?: number
  /** Width of a tile in px (the height follows the aspect ratio of the first image). */
  tile?: number
  /** Image encodings tried in order until one fits under maxBytes. */
  maxBytes?: number
}

export interface SheetImage {
  buffer: Buffer
  format: 'webp' | 'jpeg'
  width: number
  height: number
  cols: number
  rows: number
}

/**
 * Lays the frames out in a grid with each time written on its tile. The frames may be any size
 * the canvas can decode (jpeg/png/webp): they are scaled to the tile. Tiles are separated by a thin
 * gap so two frames of the same colour are still two frames.
 */
export async function composeSheet(frames: Buffer[], labels: string[], opts: SheetOptions = {}): Promise<SheetImage> {
  if (!frames.length) throw new Error('composeSheet: no frames')
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const cols = Math.max(1, Math.min(opts.cols ?? DEFAULT_COLS, frames.length))
  const rows = Math.ceil(frames.length / cols)
  const tileW = Math.max(60, Math.round(opts.tile ?? DEFAULT_TILE))
  const images = await Promise.all(frames.map((f) => loadImage(f)))
  const tileH = Math.max(1, Math.round((tileW * images[0].height) / images[0].width))
  const gap = 4
  const width = cols * tileW + (cols + 1) * gap
  const height = rows * tileH + (rows + 1) * gap
  const canvas = createCanvas(width, height)
  const g = canvas.getContext('2d')
  g.fillStyle = '#111'
  g.fillRect(0, 0, width, height)
  const fontPx = Math.max(11, Math.round(tileW * 0.075))
  g.font = `bold ${fontPx}px sans-serif`
  g.textBaseline = 'top'
  images.forEach((img, i) => {
    const x = gap + (i % cols) * (tileW + gap)
    const y = gap + Math.floor(i / cols) * (tileH + gap)
    g.drawImage(img, x, y, tileW, tileH)
    const text = labels[i] ?? ''
    if (text) {
      g.lineWidth = Math.max(3, fontPx / 4)
      g.strokeStyle = '#000'
      g.fillStyle = '#fff'
      g.lineJoin = 'round'
      g.strokeText(text, x + 6, y + 4)
      g.fillText(text, x + 6, y + 4)
    }
  })
  const limit = opts.maxBytes ?? 300_000
  let buffer = await canvas.encode('webp', 82)
  for (const q of [68, 55, 42]) {
    if (buffer.length <= limit) break
    buffer = await canvas.encode('webp', q)
  }
  return { buffer, format: 'webp', width, height, cols, rows }
}

/** Decodes the data URLs the page returns. Throws on anything that is not an image data URL. */
export function dataUrlsToBuffers(urls: string[]): Buffer[] {
  return urls.map((u, i) => {
    const m = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/.exec(u)
    if (!m) throw new Error(`frame ${i + 1} did not come back as an image`)
    return Buffer.from(m[1], 'base64')
  })
}

/** The text the agent reads about one sheet. Pure. */
export function describeSheet(o: {
  index: number
  total: number
  times: number[]
  cols: number
  rows: number
  media: string
  step?: number
}): string {
  const first = o.times[0]
  const last = o.times[o.times.length - 1]
  const step = o.step ?? (o.times.length > 1 ? (last - first) / (o.times.length - 1) : 0)
  return (
    `Sheet ${o.index}/${o.total}: ${o.times.length} frames, ${timeLabel(first)}–${timeLabel(last)}` +
    (step ? ` (every ~${step.toFixed(2)} s)` : '') +
    `, ${o.cols} columns × ${o.rows} rows, read left to right, top to bottom; the time is written on each tile. Media: ${o.media}`
  )
}
