import { BrowserWindow } from 'electron'
import path from 'node:path'
import { capturePageReliably } from './capture'
import { MOTION_SPEC } from './motion-runtime'
import { prepareMotionPreview } from './motion-preview'

/**
 * The CHEAP look at a motion composition: instead of rendering the whole
 * clip to know how it is, it captures only the requested instants and returns
 * a contact sheet (webp) with the time and the frame number in each cell.
 *
 * ONE offscreen window serves the composition through the `orbit-motion://` scheme (the same
 * one as the preview) and seeks to each instant, in the requested order — no ffmpeg and no
 * video: milliseconds, not seconds. It is the step between the preview (the panel's
 * tab, for the human) and the final render.
 *
 * Sibling of motion-preview: the time→frame conversion and the sheet geometry are
 * PURE (tested without Electron); only `captureMotionFrames` touches the window.
 */

/** Cap on instants per sheet: it is a look, not a scan of the clip. */
export const MAX_FRAME_TIMES = 8

/** Sheet width (the same as video_timeline) and cell geometry. */
const SHEET_WIDTH = 1600
const SHEET_PAD = 12
const SHEET_GAP = 10
const SHEET_HEADER = 26
/** Label band, overlaid on the cell's footer. */
const LABEL_HEIGHT = 20

// ----------------------------------------------------------- time → frame

/**
 * Converts the requested instants (in SECONDS) into WHOLE frames, validating:
 * 1 to MAX_FRAME_TIMES instants, each one finite and > 0 and — when the composition's
 * duration is known — inside it. The rounding is the same as the runtime's
 * (nearest frame) and the result is clamped to [0, durationInFrames-1]:
 * asking for 4 s of a 4 s clip returns the LAST frame, not a frame that does not
 * exist. An instant beyond the end is an error (with the maximum, so the agent can
 * correct itself).
 */
export function framesFromTimes(times: number[], opts: { fps: number; durationInFrames?: number }): number[] {
  const { fps, durationInFrames } = opts
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`invalid fps: ${fps}`)
  if (!Array.isArray(times) || times.length === 0) throw new Error('pass at least one instant, in seconds')
  if (times.length > MAX_FRAME_TIMES) {
    throw new Error(`at most ${MAX_FRAME_TIMES} instants per sheet (got ${times.length})`)
  }
  // The duration in seconds is durationInFrames / fps: an instant at the exact end of the
  // clip is accepted and falls on the last frame.
  const maxSeconds = durationInFrames && durationInFrames > 0 ? durationInFrames / fps : Infinity
  return times.map((seconds) => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`invalid instant: ${seconds} — pass seconds greater than 0`)
    }
    if (seconds > maxSeconds) {
      throw new Error(
        `instant ${seconds}s is past the end of the composition (${maxSeconds.toFixed(2)}s max at ${fps} fps)`,
      )
    }
    const frame = Math.round(seconds * fps)
    return durationInFrames && durationInFrames > 0 ? Math.min(frame, durationInFrames - 1) : Math.max(0, frame)
  })
}

// -------------------------------------------------------- sheet geometry

/**
 * Grid columns: 1 instant takes the sheet, 2 to 4 go in two columns and 5 to 8
 * in four — the cell stays large enough to judge the frame.
 */
export function sheetColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  return 4
}

export interface SheetGeometry {
  width: number
  height: number
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  pad: number
  gap: number
  header: number
}

/** Sheet grid: `count` cells of `aspect` inside `width` px. Pure. */
export function sheetLayout(input: { count: number; aspect?: number; width?: number; columns?: number }): SheetGeometry {
  const count = Math.max(1, Math.floor(input.count) || 1)
  const width = input.width ?? SHEET_WIDTH
  const aspect = input.aspect && Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 16 / 9
  const columns = input.columns ?? sheetColumns(count)
  const rows = Math.ceil(count / columns)
  const cellWidth = (width - SHEET_PAD * 2 - SHEET_GAP * (columns - 1)) / columns
  const cellHeight = cellWidth / aspect
  return {
    width,
    height: Math.round(SHEET_PAD * 2 + SHEET_HEADER + rows * cellHeight + SHEET_GAP * (rows - 1)),
    columns,
    rows,
    cellWidth,
    cellHeight,
    pad: SHEET_PAD,
    gap: SHEET_GAP,
    header: SHEET_HEADER,
  }
}

/** Rectangle of the cell at `index` (the image; the label is overlaid on the footer). */
export function sheetCell(geometry: SheetGeometry, index: number): { x: number; y: number; width: number; height: number } {
  const column = index % geometry.columns
  const row = Math.floor(index / geometry.columns)
  return {
    x: Math.round(geometry.pad + column * (geometry.cellWidth + geometry.gap)),
    y: Math.round(geometry.pad + geometry.header + row * (geometry.cellHeight + geometry.gap)),
    width: Math.round(geometry.cellWidth),
    height: Math.round(geometry.cellHeight),
  }
}

/**
 * Cell label: the *requested* time (not the rounded frame's — the agent
 * needs to recognize the instant it chose itself) and the whole frame it
 * fell on.
 */
export function frameLabel(timeMs: number, frame: number): string {
  return `${(timeMs / 1000).toFixed(2)}s · f${frame}`
}

/**
 * File name of the sheet, from the composition's folder: what is not safe
 * in a file name becomes '-', repeated separators become one (no
 * "aaa---bbb") and the name cannot start or end with a dot or a hyphen — on
 * Windows that would create an invisible or invalid file.
 */
export function sheetFileName(name: string): string {
  const base = (name ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${base || 'motion'}.webp`
}

// ------------------------------------------------------------ sheet (canvas)

export interface FrameShot {
  /** Frame captured in the window (PNG). */
  png: Buffer
  /** Requested instant, in ms. */
  timeMs: number
  /** Whole frame captured. */
  frame: number
}

export interface FrameSheet {
  /** Composition name — it becomes the sheet's header. */
  title: string
  fps: number
  durationInFrames?: number
  shots: FrameShot[]
}

/**
 * Assembles the contact sheet (webp) with `@napi-rs/canvas` — the same library as
 * video_timeline. One cell per instant, in the requested order, with the time and the
 * frame printed on it; the header says which composition and which format the
 * sheet is.
 */
export async function renderFrameSheet(sheet: FrameSheet): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const images = await Promise.all(sheet.shots.map((shot) => loadImage(shot.png)))
  const first = images[0]
  if (!first) throw new Error('no frames to draw')
  const geometry = sheetLayout({ count: images.length, aspect: first.width / first.height })
  const canvas = createCanvas(geometry.width, geometry.height)
  const g = canvas.getContext('2d')

  g.fillStyle = '#111317'
  g.fillRect(0, 0, geometry.width, geometry.height)

  g.fillStyle = '#9aa0aa'
  g.font = '16px sans-serif'
  const total = sheet.durationInFrames ? ` · ${sheet.durationInFrames} frames` : ''
  g.fillText(`${sheet.title} · ${sheet.fps} fps${total}`, geometry.pad, geometry.pad + 17)

  sheet.shots.forEach((shot, i) => {
    const cell = sheetCell(geometry, i)
    g.drawImage(images[i], cell.x, cell.y, cell.width, cell.height)
    const label = frameLabel(shot.timeMs, shot.frame)
    g.font = '13px sans-serif'
    const width = Math.ceil(g.measureText(label).width) + 10
    g.fillStyle = 'rgba(0,0,0,0.65)'
    g.fillRect(cell.x, cell.y + cell.height - LABEL_HEIGHT, Math.min(width, cell.width), LABEL_HEIGHT)
    g.fillStyle = '#e6e6e6'
    g.fillText(label, cell.x + 5, cell.y + cell.height - 5)
  })

  return canvas.encode('webp', 82)
}

// ------------------------------------------------------- visible content

/** One block of text the viewer can actually see on a frame. */
export interface VisibleText {
  text: string
  /** Box in composition pixels. */
  x: number
  y: number
  width: number
  height: number
  /** Effective opacity (the element's times every ancestor's), 0–1. */
  opacity: number
}

/** What a frame shows, read from the DOM — for models that cannot look at the image. */
export interface FrameContent {
  texts: VisibleText[]
  /** Text blocks that exist on the page but are invisible on this frame (opacity 0, hidden, off-frame). */
  hiddenTexts: number
  /** Visible images, videos, canvases and SVGs. */
  media: number
}

/** Text blocks listed per frame: past this it is a wall, not a check. */
const MAX_TEXTS_PER_FRAME = 12

/**
 * Runs in the page after a seek: every element that directly holds text, with
 * its box and its EFFECTIVE opacity. An element whose own opacity is 1 inside a
 * parent at 0 is invisible — the classic "the words never appear" bug — so the
 * opacity is multiplied up the tree.
 */
const VISIBLE_CONTENT = `(() => {
  const W = window.innerWidth, H = window.innerHeight
  const op = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none') return 0; o *= parseFloat(cs.opacity || '1') } return o }
  const shown = (el, r) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H }
  const texts = []; let hidden = 0
  const seen = new Set()
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement
    if (!el || seen.has(el) || !node.textContent.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue
    seen.add(el)
    const r = el.getBoundingClientRect(); const o = op(el)
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!text) continue
    if (o < 0.05 || !shown(el, r)) { hidden++; continue }
    texts.push({ text: text.slice(0, 80), x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), opacity: Math.round(o * 100) / 100 })
  }
  let media = 0
  for (const el of document.querySelectorAll('img, video, canvas, svg')) {
    if (el.parentElement && el.parentElement.closest('svg')) continue
    const r = el.getBoundingClientRect()
    if (op(el) >= 0.05 && shown(el, r)) media++
  }
  // Nested text blocks repeat their children's words: keep the innermost ones.
  const inner = texts.filter((t) => !texts.some((u) => u !== t && u.text !== t.text && t.text.includes(u.text) && u.x >= t.x && u.y >= t.y && u.x + u.width <= t.x + t.width + 1 && u.y + u.height <= t.y + t.height + 1))
  return { texts: inner, hiddenTexts: hidden, media }
})()`

/**
 * Words animated one by one are separate elements; the agent reads a LINE. Boxes
 * on the same baseline, same height and same opacity, side by side, become one
 * entry (in reading order). Pure.
 */
export function mergeTextLines(texts: VisibleText[]): VisibleText[] {
  const sorted = [...texts].sort((a, b) => a.y - b.y || a.x - b.x)
  const out: VisibleText[] = []
  for (const t of sorted) {
    const last = out[out.length - 1]
    const sameLine =
      last &&
      Math.abs(last.y - t.y) <= 3 &&
      Math.abs(last.height - t.height) <= 3 &&
      Math.abs(last.opacity - t.opacity) < 0.05 &&
      t.x >= last.x + last.width - 2 &&
      t.x - (last.x + last.width) <= t.height
    if (sameLine) {
      out[out.length - 1] = { ...last, text: `${last.text} ${t.text}`, width: t.x + t.width - last.x }
    } else out.push({ ...t })
  }
  return out
}

/** One line per frame for the agent: what is on screen, where, and how faint. Pure. */
export function describeFrameContent(label: string, content: FrameContent, size: { width: number; height: number }): string {
  const { hiddenTexts, media } = content
  const texts = mergeTextLines(content.texts)
  const hidden = hiddenTexts ? `; ${hiddenTexts} text block(s) on the page are invisible here` : ''
  const mediaText = media ? `${media} image/video/canvas/svg visible` : 'no image/video/canvas/svg visible'
  if (!texts.length) return `${label}: NO visible text — ${mediaText}${hidden}.`
  const zone = (t: VisibleText) => {
    const cx = (t.x + t.width / 2) / size.width
    const cy = (t.y + t.height / 2) / size.height
    const v = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle'
    const h = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center'
    return `${v}-${h}`
  }
  const shown = texts.slice(0, MAX_TEXTS_PER_FRAME).map((t) => {
    const faint = t.opacity < 0.95 ? `, opacity ${t.opacity}` : ''
    const partial = t.x < 0 || t.y < 0 || t.x + t.width > size.width || t.y + t.height > size.height ? ', partly off-frame' : ''
    return `"${t.text}" (${zone(t)}, ${t.width}x${t.height}px${faint}${partial})`
  })
  const more = texts.length > MAX_TEXTS_PER_FRAME ? ` +${texts.length - MAX_TEXTS_PER_FRAME} more` : ''
  return `${label}: ${shown.join(' · ')}${more} — ${mediaText}${hidden}.`
}

// -------------------------------------------------------------- capture

/** Snapshot of the state of the composition published by the runtime (see MOTION_SPEC). */
interface MotionPageSpec {
  width?: number
  height?: number
  fps?: number
  durationInFrames?: number
  failedFonts?: string[]
  scriptErrors?: string[]
}

/** The runtime exposes the seek through an accessor; without it, there is nothing to capture. */
const BRIDGE_CHECK = '!!(window.orbitMotion && typeof window.orbitMotion.seek === "function")'

export interface MotionFrameRequest {
  /** Target already resolved (absolute): the entry .html or its folder. */
  target: string
  /** Instants in SECONDS, in the order they must be captured. */
  times: number[]
  /** Working folder that registers the composition and the session. */
  root?: string
  sessionId?: string
  signal?: AbortSignal
}

export interface MotionFrameResult {
  /** Contact sheet (webp). */
  image: Buffer
  /** Composition name (its folder) — the sheet's header. */
  name: string
  /** Entry served and the scheme URL it came from. */
  file: string
  url: string
  fps: number
  durationInFrames: number
  /** Captured size (what the window painted), useful to judge the framing. */
  width: number
  height: number
  /** Fonts that failed (the text fell back, silently). */
  failedFonts: string[]
  /** Errors thrown by the composition's scripts. */
  scriptErrors: string[]
  /** One per requested instant, in the SAME order. */
  cells: { timeMs: number; frame: number; content: FrameContent | null }[]
}

/**
 * Captures the requested instants in a single offscreen window and returns the sheet.
 * The format (fps, duration, size) is what the composition itself declared — read
 * from the runtime, the same one the render uses, so the sheet shows what the render
 * would produce on those frames.
 */
export async function captureMotionFrames(req: MotionFrameRequest): Promise<MotionFrameResult> {
  const preview = await prepareMotionPreview(req.target, { root: req.root, sessionId: req.sessionId })
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // The composition is a video page, not a browser: nothing about leaving it.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const onAbort = () => {
    if (!win.isDestroyed()) win.destroy()
  }
  req.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // The runtime enters as the FIRST script of the <head> — it is the protocol of the scheme
    // that serves the entry (the same path as the preview).
    await win.loadURL(preview.url)
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
    const spec = (await win.webContents.executeJavaScript(MOTION_SPEC, true)) as MotionPageSpec | null
    if (!spec) throw new Error('motion runtime did not load in the capture window')
    const fps = spec.fps ?? 30
    const durationInFrames = spec.durationInFrames
    if (!durationInFrames) {
      throw new Error(
        'unknown duration: declare <meta name="orbit-motion" content="duration=…">, window.orbitMotion.durationInFrames or window.orbitTimeline',
      )
    }
    // Without the bridge the seek would fail in there with an opaque TypeError: better to say
    // right away why the window cannot be used to capture.
    if (!(await win.webContents.executeJavaScript(BRIDGE_CHECK, true))) {
      throw new Error('window.orbitMotion.seek(frame) is missing in the capture window — the runtime did not take over the composition')
    }
    const frames = framesFromTimes(req.times, { fps, durationInFrames })
    win.setContentSize(Math.round(spec.width ?? 1920), Math.round(spec.height ?? 1080))
    await win.webContents.executeJavaScript(`window.orbitMotion.fps = ${fps}`, true)

    const shots: FrameShot[] = []
    const contents: (FrameContent | null)[] = []
    let width = Math.round(spec.width ?? 1920)
    let height = Math.round(spec.height ?? 1080)
    for (let i = 0; i < frames.length; i++) {
      if (req.signal?.aborted) throw new Error('cancelled')
      // Whole frame, in the requested order: the runtime converts to seconds in there.
      await win.webContents.executeJavaScript(`window.orbitMotion.seek(${frames[i]})`, true)
      const image = await capturePageReliably(win.webContents)
      // Read AFTER the capture: the paint has settled, so the DOM says what the image shows.
      contents.push(((await win.webContents.executeJavaScript(VISIBLE_CONTENT, true).catch(() => null)) as FrameContent | null) ?? null)
      if (i === 0) {
        const size = image.getSize()
        if (size.width > 0 && size.height > 0) {
          width = size.width
          height = size.height
        }
      }
      shots.push({ png: image.toPNG(), timeMs: req.times[i] * 1000, frame: frames[i] })
    }

    const name = path.basename(preview.folder)
    const sheet = await renderFrameSheet({ title: name, fps, durationInFrames, shots })
    return {
      image: sheet,
      name,
      file: preview.file,
      url: preview.url,
      fps,
      durationInFrames,
      width,
      height,
      failedFonts: spec.failedFonts ?? [],
      scriptErrors: spec.scriptErrors ?? [],
      cells: shots.map((shot, i) => ({ timeMs: shot.timeMs, frame: shot.frame, content: contents[i] ?? null })),
    }
  } finally {
    req.signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}
