import { BrowserWindow, app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ConsoleBuffer,
  attachConsole,
  formatConsoleEntries,
  mouseDown,
  mouseMove,
  mouseUp,
} from './browser-input'
import { DEFAULT_VIEWPORT, createHiddenWindow } from './browser-script'
import { panelActivity } from './panel-browser'
import { tNow } from './i18n'
import { detectMachine } from './machine'
import { runFfmpeg } from './video/ffmpeg'
import {
  describeProfile,
  resolveRecordProfile,
  type RecordPreset,
  type RecordQuality,
} from './video/record-profile'

/**
 * Recording of a SCRIPT in the hidden browser (the `browser_record` tool).
 *
 * The idea: instead of filming the agent working (which waits for the model to think
 * between each step), the script is a list of actions that the main executes in
 * sequence — click, type, scroll, wait — while the framebuffer of the hidden
 * window is captured and becomes an MP4. The video is deterministic and short: it
 * lasts as long as the actions, not as long as the reasoning.
 *
 * Capture in two modes, chosen at runtime:
 *
 * - `screencast` (preferred): CDP `Page.startScreencast` on the webContents. The
 *   Chromium emits a JPEG per painted frame, with a mandatory ack — it is the same
 *   mechanism as DevTools, cheap and with the real timing of the animations.
 * - `capturePage` (fallback): if no frame arrives (a hidden window that does not
 *   composite), a loop calls `webContents.capturePage()` at the fps pace. More
 *   expensive, but known to work with `paintWhenInitiallyHidden`.
 *
 * In both cases what is recorded are frames with a TIMESTAMP. The video is assembled
 * afterwards: each frame becomes an entry with a `duration` in ffmpeg's concat demuxer,
 * which normalizes to a constant fps — a repeated frame costs nothing and
 * a still stretch holds the last image for the real time it lasted.
 *
 * The cursor is an element injected IN THE PAGE, positioned with the SAME
 * coordinate that the click uses (`pointFor`): there is no conversion between the drawing and
 * the event, so it lands exactly on the target by construction. On the screens
 * where the page navigates, the element is reinjected on the next action.
 */

export type RecordStep =
  | { do: 'goto'; url: string; waitMs?: number }
  | { do: 'click'; selector?: string; text?: string; x?: number; y?: number; waitMs?: number }
  | {
      do: 'type'
      selector?: string
      text?: string
      x?: number
      y?: number
      value: string
      clear?: boolean
      submit?: boolean
      typeDelayMs?: number
      waitMs?: number
    }
  | { do: 'hover'; selector?: string; text?: string; x?: number; y?: number }
  | { do: 'scroll'; dy?: number; to?: 'top' | 'bottom'; selector?: string }
  | { do: 'wait'; ms: number }
  | { do: 'waitFor'; selector: string; timeoutMs?: number }
  | { do: 'press'; key: string }
  | { do: 'move'; x: number; y: number }

export interface RecordOptions {
  sessionId: string
  /** Start page — loaded BEFORE starting to record (the video opens on it already). */
  url?: string
  steps: RecordStep[]
  viewport?: { width: number; height: number }
  /**
   * Quality profile. `auto` (default) follows the machine — a strong one records at 60 fps
   * in high quality. An explicit level ALWAYS beats the tier.
   */
  quality?: RecordQuality
  /** Frames per second (10-60). Beats the profile. */
  fps?: number
  /** Final width of the video (even, in px). Absent = captured size. */
  width?: number
  /** Cursor drawn on the page (default: true). */
  cursor?: boolean
  /** Still frames at the end, so the last transition finishes inside the video. */
  tailMs?: number
  /** File name (becomes the title in the gallery). */
  name?: string
  /** x264 quality (lower = better/bigger file). Beats the profile. */
  crf?: number
  /** Preserves the frames folder (debugging). */
  keepFrames?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RecordResult {
  file: string
  durationMs: number
  frames: number
  engine: 'screencast' | 'capturePage'
  /** fps of the final video (what was requested/the profile). */
  fps: number
  /**
   * Distinct frames per second that the page produced. It is NOT the machine's
   * capacity: Chromium only emits a frame when something changes, so a still screen
   * gives a low number and a perfect video (the final fps is `fps`, with the frames
   * repeated by the encoder).
   */
  capturedFps: number
  /** Resolved profile (quality is never `auto`). */
  quality: Exclude<RecordQuality, 'auto'>
  crf: number
  /** Tier of the machine used when the quality was `auto`. */
  tier: 'weak' | 'balanced' | 'strong'
  steps: number
  logs: string[]
}

export interface FrameMark {
  file: string
  /** When the frame was received (ms, main's clock). */
  at: number
}

/** One concat demuxer entry: file + how long it stays on screen. */
export interface TimelineEntry {
  file: string
  durationMs: number
}

export interface TimelineOptions {
  /** End of the recording (ms) — feeds the duration of the last frame. */
  endedAt: number
  /** Extra wait on the last frame (the final transition has to fit in the video). */
  tailMs?: number
}

/**
 * Converts frames with a timestamp into a timeline of durations.
 *
 * The video STARTS at the first frame (the time spent loading the page before
 * it does not enter) and each frame lasts until the next one. Frames that arrived
 * together get a minimum of 1ms so as not to generate `duration 0` in the concat.
 */
export function frameTimeline(frames: FrameMark[], options: TimelineOptions): TimelineEntry[] {
  if (frames.length === 0) return []
  const ordered = [...frames].sort((a, b) => a.at - b.at)
  const minMs = 1
  const entries = ordered.map((frame, index) => {
    const next = ordered[index + 1]
    const end = next ? next.at : Math.max(options.endedAt + (options.tailMs ?? 0), frame.at + minMs)
    return { file: frame.file, durationMs: Math.max(minMs, end - frame.at) }
  })
  return entries
}

export function timelineDurationMs(entries: TimelineEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.durationMs, 0)
}

/** Concat demuxer: `file` + `duration` per frame, with the last one repeated
 *  (otherwise ffmpeg discards the duration of the last entry). */
export function concatList(entries: TimelineEntry[]): string {
  const lines = ['ffconcat version 1.0']
  for (const entry of entries) {
    lines.push(`file '${entry.file.replace(/'/g, "'\\''")}'`)
    lines.push(`duration ${(entry.durationMs / 1000).toFixed(4)}`)
  }
  if (entries.length > 0) lines.push(`file '${entries[entries.length - 1].file.replace(/'/g, "'\\''")}'`)
  return `${lines.join('\n')}\n`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recordingsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'recordings')
}

function safeName(raw?: string): string {
  const cleaned = (raw ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || `rec-${Date.now().toString(36)}`
}

/** Cursor arrow, black/white to show up on any background. */
const CURSOR_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M5 3.2 L5 19.6 L9.3 15.3 L12.2 21.3 L15 20 L12.1 14.2 L18 14.2 Z" ' +
  'fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>'

/** Creates (if needed) and moves the cursor. `ripple` lights up the click wave.
 *  Exported so the test can run the SAME code inside a page. */
export function cursorScript(point: { x: number; y: number }, ripple: boolean, enabled: boolean): string {
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  return `(() => {
  if (!${enabled}) return false
  const root = document.body || document.documentElement
  let cursor = document.getElementById('__orbit_cursor')
  if (!cursor) {
    cursor = document.createElement('div')
    cursor.id = '__orbit_cursor'
    cursor.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;'
      + 'z-index:2147483647;will-change:transform;transition:transform .2s cubic-bezier(.2,.8,.2,1);'
      + 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))'
    cursor.innerHTML = ${JSON.stringify(CURSOR_SVG)}
    root.appendChild(cursor)
  }
  // -4.6/-2.9 is the arrow tip inside the 24×24 viewBox drawn at 22px:
  // that way the TIP lands on the clicked point, not the corner of the div.
  cursor.style.transform = 'translate3d(' + (${x} - 4.6) + 'px,' + (${y} - 2.9) + 'px,0)'
  if (${ripple}) {
    const ring = document.createElement('div')
    ring.style.cssText = 'position:fixed;left:0;top:0;width:38px;height:38px;'
      + 'margin:-19px 0 0 -19px;border-radius:50%;pointer-events:none;z-index:2147483646;'
      + 'background:radial-gradient(circle,rgba(255,255,255,.9) 0%,rgba(120,170,255,.55) 55%,rgba(120,170,255,0) 72%);'
      + 'transform:translate3d(${x}px,${y}px,0) scale(.3);opacity:.95;'
      + 'transition:transform .42s ease-out,opacity .42s ease-out'
    root.appendChild(ring)
    requestAnimationFrame(() => {
      ring.style.transform = 'translate3d(${x}px,${y}px,0) scale(1)'
      ring.style.opacity = '0'
    })
    setTimeout(() => ring.remove(), 700)
  }
  return true
})()`
}

interface PointTarget {
  selector?: string
  text?: string
  x?: number
  y?: number
}

/**
 * Point (CSS px of the viewport) of a target: raw coordinates, a CSS selector or
 * visible text. It scrolls the element to the center BEFORE measuring — the measurement and the
 * click use exactly the same number.
 */
export function pointScript(target: PointTarget): string {
  const t = JSON.stringify(target)
  return `(() => {
  const T = ${t}
  if (typeof T.x === 'number' && typeof T.y === 'number') return { x: T.x, y: T.y }
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
  let el = null
  if (T.selector) {
    el = document.querySelector(T.selector)
    if (!el) return { error: 'element not found: ' + T.selector }
  } else {
    const want = norm(T.text)
    if (!want) return { error: 'provide selector, text or x/y' }
    const sel = 'a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],'
      + 'input:not([type="hidden"]),select,textarea,label,summary,li,h1,h2,h3,h4,h5,p,span,div'
    let bestEl = null
    let bestScore = 0
    let bestArea = Infinity
    for (const candidate of document.querySelectorAll(sel)) {
      const rect = candidate.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue
      const hits = [
        norm(candidate.textContent),
        norm(candidate.getAttribute('aria-label')),
        norm(candidate.getAttribute('placeholder')),
        norm(candidate.getAttribute('title')),
        norm(candidate.value),
      ]
      let score = 0
      for (const hit of hits) {
        if (!hit) continue
        if (hit === want) { score = 4; break }
        if (hit.includes(want)) score = Math.max(score, hit.length <= want.length + 24 ? 3 : 2)
      }
      if (!score) continue
      const area = rect.width * rect.height
      if (score > bestScore || (score === bestScore && area < bestArea)) {
        bestEl = candidate
        bestScore = score
        bestArea = area
      }
    }
    if (!bestEl) return { error: 'no element matching the text: ' + T.text }
    el = bestEl
  }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`
}

/** Short text for the log/activity: "click «Sign in»". */
function describeStep(step: RecordStep): string {
  switch (step.do) {
    case 'goto':
      return `goto ${step.url}`
    case 'click':
      return `click ${step.selector ?? (step.text ? `"${step.text}"` : `${step.x},${step.y}`)}`
    case 'type':
      return `type ${step.selector ?? (step.text ? `"${step.text}"` : `${step.x},${step.y}`)}`
    case 'hover':
      return `hover ${step.selector ?? (step.text ? `"${step.text}"` : `${step.x},${step.y}`)}`
    case 'scroll':
      return `scroll ${step.to ?? `${step.dy ?? 600}px`}`
    case 'wait':
      return `wait ${step.ms}ms`
    case 'waitFor':
      return `waitFor ${step.selector}`
    case 'press':
      return `press ${step.key}`
    case 'move':
      return `move ${step.x},${step.y}`
  }
}

/** Waits for the load to finish and gives the SPA time to hydrate. */
async function settle(win: BrowserWindow, graceMs = 300): Promise<void> {
  const deadline = Date.now() + 15_000
  while (win.webContents.isLoading() && Date.now() < deadline) await delay(120)
  await delay(graceMs)
}

async function scrollSettle(win: BrowserWindow): Promise<void> {
  let last = Number.NaN
  let stable = 0
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const y = (await win.webContents.executeJavaScript('window.scrollY', true).catch(() => 0)) as number
    if (y === last) {
      stable += 1
      if (stable >= 3) return
    } else {
      stable = 0
      last = y
    }
    await delay(80)
  }
}

/**
 * Frame recorder. One of the two modes, chosen at the start: if the screencast
 * does not deliver the first frame within `PROBE_MS`, it falls back to the `capturePage` loop.
 */
class FrameRecorder {
  private frames: FrameMark[] = []
  private seq = 0
  private dir: string
  private writing: Promise<void> = Promise.resolve()
  private startedAt = 0
  private stoppedAt = 0
  private mode: 'screencast' | 'capturePage' = 'screencast'
  private loopTimer: NodeJS.Timeout | null = null
  private loopStopped = false
  private failing = 0
  private readonly PROBE_MS = 600

  constructor(
    private readonly win: BrowserWindow,
    private readonly options: { dir: string; fps: number; quality: number; maxWidth: number; maxHeight: number },
  ) {
    this.dir = options.dir
  }

  get engine(): 'screencast' | 'capturePage' {
    return this.mode
  }

  get count(): number {
    return this.frames.length
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    this.startedAt = Date.now()
    try {
      await this.startScreencast()
      const works = await this.waitForFirstFrame(this.PROBE_MS)
      if (works) return
      await this.stopScreencast()
    } catch {
      // CDP unavailable on this page/Electron: goes on to capturePage
    }
    this.mode = 'capturePage'
    this.startCaptureLoop()
  }

  private async startScreencast(): Promise<void> {
    const dbg = this.win.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    dbg.on('message', (_event, method, params) => {
      if (method !== 'Page.screencastFrame') return
      const frame = params as { data: string; sessionId: number }
      const at = Date.now()
      const file = path.join(this.dir, `f${String(++this.seq).padStart(5, '0')}.jpg`)
      this.frames.push({ file, at })
      // Records serially and acks immediately: waiting for the disk before the ack
      // makes Chromium stop emitting frames.
      this.writing = this.writing
        .then(() => fsp.writeFile(file, Buffer.from(frame.data, 'base64')))
        .catch(() => undefined)
      void dbg.sendCommand('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    })
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: this.options.quality,
      maxWidth: this.options.maxWidth,
      maxHeight: this.options.maxHeight,
      everyNthFrame: 1,
    })
  }

  private async waitForFirstFrame(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.frames.length > 0) return true
      await delay(40)
    }
    return this.frames.length > 0
  }

  private async stopScreencast(): Promise<void> {
    const dbg = this.win.webContents.debugger
    if (!dbg.isAttached()) return
    await dbg.sendCommand('Page.stopScreencast').catch(() => undefined)
    try {
      dbg.detach()
    } catch {
      // already detached
    }
  }

  private startCaptureLoop(): void {
    const budget = Math.max(16, Math.round(1000 / this.options.fps))
    const tick = async () => {
      if (this.loopStopped) return
      const started = Date.now()
      try {
        const image = await this.win.webContents.capturePage()
        const file = path.join(this.dir, `f${String(++this.seq).padStart(5, '0')}.png`)
        await fsp.writeFile(file, image.toPNG())
        this.frames.push({ file, at: Date.now() })
        this.failing = 0
      } catch {
        // Window destroyed/closing: two failures in a row end the loop.
        this.failing += 1
        if (this.failing >= 2) return
      }
      const elapsed = Date.now() - started
      this.loopTimer = setTimeout(tick, Math.max(0, budget - elapsed))
    }
    void tick()
  }

  async stop(): Promise<void> {
    this.stoppedAt = Date.now()
    this.loopStopped = true
    if (this.loopTimer) clearTimeout(this.loopTimer)
    if (this.mode === 'screencast') await this.stopScreencast()
    await this.writing
  }

  /** Final timeline, already with the requested tail. */
  timeline(tailMs: number): TimelineEntry[] {
    return frameTimeline(this.frames, { endedAt: this.stoppedAt || Date.now(), tailMs })
  }

  get firstAt(): number {
    return this.frames[0]?.at ?? this.startedAt
  }

  /** When the recording stopped — anchors the duration of the last frame. */
  get endedAt(): number {
    return this.stoppedAt
  }
}

/** Encodes the frames into MP4 (H.264, yuv420p, faststart). */
async function encodeFrames(
  entries: TimelineEntry[],
  output: string,
  opts: { fps: number; width?: number; crf: number; preset: RecordPreset },
): Promise<void> {
  const listFile = `${output}.concat.txt`
  await fsp.writeFile(listFile, concatList(entries), 'utf8')
  const width = opts.width && opts.width > 0 ? Math.round(opts.width / 2) * 2 : 0
  // `in_range=full:out_range=tv` is mandatory, not decoration: the frames come from
  // JPEG/PNG, which are FULL range (0-255). Without the conversion, ffmpeg tags the
  // H.264 as `yuvj420p` and players that ignore that flag (QuickTime among
  // them) show the video washed out. The `-pix_fmt yuv420p` alone does NOT solve it —
  // what rules is the range conversion in the scale.
  const range = 'in_range=full:out_range=tv'
  const scale = width
    ? `scale=${width}:-2:flags=lanczos:${range},format=yuv420p`
    : `scale=trunc(iw/2)*2:trunc(ih/2)*2:${range},format=yuv420p`
  try {
    await runFfmpeg(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-fps_mode',
        'cfr',
        '-r',
        String(opts.fps),
        '-vf',
        scale,
        '-c:v',
        'libx264',
        '-preset',
        opts.preset,
        '-crf',
        String(opts.crf),
        '-movflags',
        '+faststart',
        '-an',
        output,
      ],
      // Without `signal`: the encode of a few seconds must not be aborted midway
      // (the signal was already consumed in the script, and a truncated MP4 would be worse).
    )
  } finally {
    await fsp.rm(listFile, { force: true })
  }
}

/**
 * Runs the script and returns the MP4. Unlike `runBrowserScript`, the script
 * is NOT free JS: they are declarative steps, so that the video is predictable.
 */
export async function recordBrowserScript(options: RecordOptions): Promise<RecordResult> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  // The machine decides the DEFAULT; an explicitly requested level beats it.
  const machine = detectMachine()
  const profile = resolveRecordProfile(
    { quality: options.quality, fps: options.fps, crf: options.crf },
    machine.tier,
  )
  const fps = profile.fps
  const timeoutMs = options.timeoutMs ?? 180_000
  const deadline = Date.now() + timeoutMs
  const logs: string[] = []
  const pushLog = (line: string) => {
    if (logs.length < 200) logs.push(line)
  }

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const framesDir = path.join(recordingsDir(), `frames-${stamp}`)
  const name = safeName(options.name)
  const output = path.join(recordingsDir(), `${name}-${stamp}.mp4`)

  const win = createHiddenWindow(viewport)
  const pageConsole = new ConsoleBuffer()
  attachConsole(win.webContents, () => pageConsole)

  const checkAbort = () => {
    if (options.signal?.aborted) throw new Error('recording cancelled')
    if (Date.now() > deadline) {
      throw new Error(`the scripted recording exceeded ${Math.round(timeoutMs / 1000)}s`)
    }
  }

  const evaluate = async <T>(code: string): Promise<T> => {
    return (await win.webContents.executeJavaScript(code, true)) as T
  }

  const pointFor = async (target: PointTarget): Promise<{ x: number; y: number }> => {
    const result = await evaluate<{ x?: number; y?: number; error?: string }>(pointScript(target))
    if (result?.error) throw new Error(result.error)
    if (typeof result?.x !== 'number' || typeof result?.y !== 'number') throw new Error('could not resolve the target')
    return { x: result.x, y: result.y }
  }

  const showCursor = async (point: { x: number; y: number }, ripple = false) => {
    await evaluate(cursorScript(point, ripple, options.cursor !== false)).catch(() => false)
  }

  const goto = async (url: string) => {
    panelActivity(tNow('panel.activity.scriptOpen', { url }))
    try {
      await Promise.race([win.loadURL(url), delay(20_000)])
    } catch (err) {
      // ERR_ABORTED (-3) is normal in an SPA/redirect
      if ((err as { errno?: number }).errno !== -3) throw err
    }
    await settle(win, 400)
  }

  /** Puts the cursor in the resting corner so the first action is a movement. */
  const restCursor = async () => {
    if (options.cursor === false) return
    await showCursor({ x: viewport.width * 0.68, y: viewport.height * 0.64 })
  }

  const press = async (key: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    if (key.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: key })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
  }

  let recorder: FrameRecorder | null = null
  let ran = 0
  let error: string | undefined

  try {
    // Preparation OUTSIDE the video: loading the start page and a `goto` that is
    // the first step. The video opens on the page ready, without a white screen.
    if (options.url) await goto(options.url)
    let start = 0
    if (options.steps[0]?.do === 'goto') {
      await goto(options.steps[0].url)
      start = 1
    }
    await restCursor()

    // Screencast ceiling = the profile's, limited by the real size of the window in
    // device pixels (2x on a Retina). The height follows the aspect so that
    // Chromium does not crop the image when reducing.
    const capWidth = Math.min(profile.maxWidth, Math.round(viewport.width * 2))
    const capHeight = Math.min(
      Math.round(capWidth / (viewport.width / viewport.height)),
      Math.round(viewport.height * 2),
    )
    recorder = new FrameRecorder(win, {
      dir: framesDir,
      fps,
      quality: profile.jpegQuality,
      maxWidth: capWidth,
      maxHeight: capHeight,
    })
    await recorder.start()
    panelActivity(tNow('panel.activity.recordStart', { url: win.webContents.getURL() || 'about:blank' }))
    pushLog(`engine: ${recorder.engine} · ${describeProfile(profile, machine.tier)}`)
    pushLog(
      `machine: ${machine.tier} · ${machine.cpus} cores · ${machine.totalMemGb} GB · ${machine.arch}`,
    )

    for (let index = start; index < options.steps.length; index += 1) {
      checkAbort()
      const step = options.steps[index]
      panelActivity(tNow('panel.activity.recordStep', { label: describeStep(step) }))
      switch (step.do) {
        case 'goto':
          await goto(step.url)
          await restCursor()
          if (step.waitMs) await delay(step.waitMs)
          break
        case 'click': {
          const point = await pointFor(step)
          await showCursor(point)
          await delay(230) // the cursor transition ends before the click
          await showCursor(point, true)
          mouseDown(win.webContents, point)
          await delay(60)
          mouseUp(win.webContents, point)
          await settle(win, step.waitMs ?? 320)
          break
        }
        case 'type': {
          const point = await pointFor(step)
          await showCursor(point)
          await delay(230)
          mouseDown(win.webContents, point)
          await delay(50)
          mouseUp(win.webContents, point)
          await delay(140)
          if (step.clear) {
            const modifier = process.platform === 'darwin' ? 'meta' : 'control'
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [modifier] })
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [modifier] })
            await delay(60)
          }
          const typingDelay = Math.min(120, Math.max(0, step.typeDelayMs ?? 40))
          for (const char of step.value) {
            win.webContents.insertText(char)
            if (typingDelay) await delay(typingDelay)
          }
          if (step.submit) {
            await delay(120)
            await press('Enter')
          }
          await settle(win, step.waitMs ?? 260)
          break
        }
        case 'hover': {
          const point = await pointFor(step)
          await showCursor(point)
          mouseMove(win.webContents, point)
          await delay(350)
          break
        }
        case 'scroll': {
          if (step.selector) {
            await evaluate(
              `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return !!el })()`,
            )
          } else if (step.to === 'top') {
            await evaluate(`window.scrollTo({ top: 0, behavior: 'smooth' })`)
          } else if (step.to === 'bottom') {
            await evaluate(
              `window.scrollTo({ top: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0), behavior: 'smooth' })`,
            )
          } else {
            await evaluate(`window.scrollBy({ top: ${Math.round(step.dy ?? 600)}, behavior: 'smooth' })`)
          }
          await scrollSettle(win)
          await delay(200)
          break
        }
        case 'wait':
          await delay(Math.max(0, step.ms))
          break
        case 'waitFor': {
          const limit = Date.now() + Math.min(step.timeoutMs ?? 10_000, 30_000)
          let found = false
          while (Date.now() < limit) {
            found = (await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(step.selector)})`).catch(
              () => false,
            )) as boolean
            if (found) break
            await delay(150)
          }
          if (!found) throw new Error(`waitFor: selector never appeared — ${step.selector}`)
          await delay(120)
          break
        }
        case 'press':
          await press(step.key)
          await settle(win, 200)
          break
        case 'move': {
          const point = { x: step.x, y: step.y }
          await showCursor(point)
          await delay(240)
          break
        }
      }
      ran += 1
    }

    // Holds the last frame so the final animation fits in the video.
    await delay(Math.max(0, options.tailMs ?? 500))
    checkAbort()
  } catch (err) {
    error = (err as Error)?.message ?? String(err)
  } finally {
    if (recorder) {
      try {
        await recorder.stop()
      } catch {
        // window closing
      }
    }
    if (!win.isDestroyed()) win.destroy()
  }

  if (!recorder || recorder.count === 0) {
    if (!options.keepFrames) await fsp.rm(framesDir, { recursive: true, force: true })
    throw new Error(error ?? 'no frames were captured — the page may never have painted')
  }
  if (error) pushLog(`warning: ${error}`)

  // The tail IS already in the frames: the `delay` above kept the recording running
  // after the last action, and the timeline measures that through `endedAt`. Adding the tail
  // again here would double the still time at the end.
  const entries = recorder.timeline(0)
  if (entries.length === 0) throw new Error('no frames were captured')

  panelActivity(tNow('panel.activity.recordSave'))
  await fsp.mkdir(recordingsDir(), { recursive: true })
  await encodeFrames(entries, output, {
    fps,
    width: options.width,
    crf: profile.crf,
    preset: profile.preset,
  })

  if (!options.keepFrames) await fsp.rm(framesDir, { recursive: true, force: true })

  const pageErrors = pageConsole.query({ level: 'error', limit: 10 })
  if (pageErrors.length > 0) pushLog(`[page] ${pageErrors.length} error(s) in the console:\n${formatConsoleEntries(pageErrors)}`)

  // How much the machine actually delivered: `count` over the interval in which the
  // frames arrived (not over the video duration, which includes the repetitions).
  const span = Math.max(1, recorder.endedAt - recorder.firstAt)
  return {
    file: output,
    durationMs: timelineDurationMs(entries),
    frames: recorder.count,
    engine: recorder.engine,
    fps,
    capturedFps: Math.round((recorder.count / (span / 1000)) * 10) / 10,
    quality: profile.quality,
    crf: profile.crf,
    tier: machine.tier,
    steps: ran,
    logs,
  }
}
