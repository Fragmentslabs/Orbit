import { BrowserWindow } from 'electron'
import { MOTION_SPEC } from './motion-runtime'
import type { MotionSceneInfo } from './motion-scenes'
import type { MotionTransitionInfo } from './motion-transitions'
import type { MotionVideoFact } from './motion-video-audio'

/**
 * The LAYERS of a motion composition: who enters and leaves the scene, and when.
 *
 * It is what the Motion tab draws under the ruler (one track per layer, from the frame
 * in which it appears to the frame in which it vanishes) and what motion_preview tells the
 * agent. There is no layer declaration in the contract — the composition is free
 * HTML —, so they are MEASURED: the runtime scans the frames in an offscreen
 * window and says, per element, when it is visible (`__orbitMotionLayers`).
 *
 * From that raw snapshot, `pickLayers` (pure) chooses what becomes a layer:
 *   - every element with `data-layer` (the name the composition gave) comes in, even
 *     if it stays on screen the whole time — it was named to be cited;
 *   - an element without a name only comes in if it ENTERS OR LEAVES the scene (a container that
 *     is always there says nothing) and only the outermost of them: the words of
 *     a sentence that appears whole do not become ten tracks.
 */

export type FrameSpan = [number, number]

/** What kind of thing the layer is (measured in the DOM by the runtime, not declared). */
export type LayerKind = 'text' | 'image' | 'video' | 'audio' | 'other'

/** What the runtime returns per element (document order). */
export interface RawLayer {
  name: string
  named: boolean
  /** Index of the parent element among the candidates (-1 = child of body). */
  parent: number
  spans: FrameSpan[]
  /** Position in the page walk — the element's address for the highlight. */
  index?: number
  kind?: LayerKind
  /** Lowercase tag ("video", "div"…): it says whether the layer IS the media or only contains it. */
  tag?: string
}

export interface MotionLayer {
  name: string
  /** Came from `data-layer` (name given by the composition) or was inferred. */
  named: boolean
  /** Visible intervals, in whole frames, inclusive. */
  spans: FrameSpan[]
  /**
   * Index in the page walk. The label does NOT identify an element (two of them
   * may be called ".caption"), so it is through here that the preview finds the
   * element again to outline it when the layer is selected in the tab.
   */
  index: number
  kind: LayerKind
}

export interface MotionLayers {
  width: number
  height: number
  fps: number
  durationInFrames: number
  layers: MotionLayer[]
  failedFonts: string[]
  /** Errors thrown by the composition's own scripts (silent otherwise). */
  scriptErrors: string[]
  /** The transitions the composition registered (orbitMotion.transition). */
  transitions: MotionTransitionInfo[]
  /** The scenes the composition laid out (orbitMotion.scenes). */
  scenes: MotionSceneInfo[]
  /** The page's `<video>`s, so their sound enters the audio plan. */
  videos: MotionVideoFact[]
}

/** Cap on tracks: beyond that the tab becomes noise (and so does the text to the agent). */
export const MAX_LAYERS = 40

/** Joins intervals separated by gaps of up to `gap` frames (measurement blinks). */
export function mergeSpans(spans: FrameSpan[], gap = 1): FrameSpan[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const out: FrameSpan[] = []
  for (const [start, end] of sorted) {
    const prev = out[out.length - 1]
    if (prev && start - prev[1] <= gap + 1) prev[1] = Math.max(prev[1], end)
    else out.push([start, end])
  }
  return out
}

function sameSpans(a: FrameSpan[], b: FrameSpan[]): boolean {
  return a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s[1] === b[i][1])
}

/** Visible from the first frame to the last, without interruption. */
function always(spans: FrameSpan[], total: number): boolean {
  return spans.length === 1 && spans[0][0] <= 0 && spans[0][1] >= total - 1
}

/**
 * The element IS the media, and not a container that has media inside: whoever carries
 * `tag` decides for it (the `<video>` and not the `div` around it); without a tag (hand-built
 * snapshot), the measured type counts.
 */
function isMediaElement(item: RawLayer): boolean {
  if (item.tag) return item.tag === 'video' || item.tag === 'audio'
  return item.kind === 'video' || item.kind === 'audio'
}

/** Chooses the layers from the runtime's raw snapshot. Pure. */
export function pickLayers(raw: RawLayer[], durationInFrames: number, max = MAX_LAYERS): MotionLayer[] {
  const spans = raw.map((r) => mergeSpans(r.spans))
  const kept = new Array<boolean>(raw.length).fill(false)
  /** The nearest ancestor that became a layer (or -1). */
  const keptAncestor = (index: number): number => {
    let p = raw[index].parent
    while (p >= 0) {
      if (kept[p]) return p
      p = raw[p].parent
    }
    return -1
  }
  const out: MotionLayer[] = []
  /**
   * The element's address: through it the preview finds it again to outline it, and
   * what it is. The runtime sends both fields and the position in the list is the same
   * number — the defaults exist so a hand-built raw snapshot (test) does not
   * need to repeat them.
   */
  const address = (item: RawLayer, i: number): { index: number; kind: LayerKind } => ({
    index: item.index ?? i,
    kind: item.kind ?? 'other',
  })
  raw.forEach((item, i) => {
    if (spans[i].length === 0) return
    const ancestor = keptAncestor(i)
    if (item.named) {
      kept[i] = true
      out.push({ name: item.name, named: true, spans: spans[i], ...address(item, i) })
      return
    }
    // MEDIA is a layer of its own, even standing still from the first frame to the last: a video
    // that occupies the whole piece is not decoration of a text, it is the content — and without
    // this rule it vanished from the list (only those that "entered or left" came in), which is
    // precisely the layer the person wants to select and mark.
    if (isMediaElement(item)) {
      // Media inside another one already shown is the same thing twice.
      if (ancestor >= 0 && isMediaElement(raw[ancestor])) return
      kept[i] = true
      out.push({ name: item.name, named: false, spans: spans[i], ...address(item, i) })
      return
    }
    // Without a name: only those that enter/leave, and only the outermost. Inside a layer already
    // shown that ENTERS AND LEAVES (a sentence), the children are parts of it — the
    // words of a sentence do not become ten tracks. Inside a named container
    // that stays the whole time (the "stage"), the children are the content and do come in.
    if (always(spans[i], durationInFrames)) return
    if (ancestor >= 0) {
      const parent = raw[ancestor]
      if (!parent.named || !always(spans[ancestor], durationInFrames) || sameSpans(spans[ancestor], spans[i])) return
    }
    kept[i] = true
    out.push({ name: item.name, named: false, spans: spans[i], ...address(item, i) })
  })
  return out.slice(0, max)
}

/** "0:01.20" from a frame — the vocabulary of the text for the agent. */
function clock(frame: number, fps: number): string {
  const s = frame / fps
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

/**
 * Summary of the layers for the agent (one line per layer, with entry and exit).
 * Only the time matters here — the type and the address are for the tab, not for the
 * text the agent reads.
 */
export function describeLayers(layers: Array<Pick<MotionLayer, 'name' | 'named' | 'spans'>>, fps: number): string {
  if (!layers.length) return 'No element enters or leaves the frame (and none has data-layer).'
  return layers
    .map((l) => {
      const spans = l.spans.map(([a, b]) => `${clock(a, fps)}–${clock(b + 1, fps)} (f${a}–f${b})`).join(', ')
      return `- ${l.named ? l.name : `"${l.name}"`}: ${spans}`
    })
    .join('\n')
}

// ------------------------------------------------------------------ measurement

const LOAD_TIMEOUT_MS = 20_000

/** One measurement per composition at a time: a burst of saves does not open N windows. */
const inflight = new Map<string, Promise<MotionLayers>>()

/**
 * Loads the composition in an offscreen window through the SAME scheme as the preview and
 * measures the layers. It is also motion_preview's "does it open?" test: if the page
 * does not load, the error comes out of here with the reason, instead of the tab spinning.
 */
export function measureMotionLayers(id: string, url: string): Promise<MotionLayers> {
  const running = inflight.get(id)
  if (running) return running
  const job = runMeasure(url).finally(() => inflight.delete(id))
  inflight.set(id, job)
  return job
}

async function runMeasure(url: string): Promise<MotionLayers> {
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let pageError: string | null = null
  win.webContents.on('console-message', (event) => {
    const e = event as unknown as { level?: string | number; message?: string }
    if ((e.level === 'error' || e.level === 3) && !pageError && e.message) pageError = e.message
  })
  const timer = setTimeout(() => {
    if (!win.isDestroyed()) win.destroy()
  }, LOAD_TIMEOUT_MS)
  try {
    await win.loadURL(url)
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
    const spec = (await win.webContents.executeJavaScript(MOTION_SPEC, true)) as {
      width?: number
      height?: number
      fps?: number
      durationInFrames?: number
      failedFonts?: string[]
      scriptErrors?: string[]
      transitions?: MotionTransitionInfo[]
      scenes?: MotionSceneInfo[]
      videos?: MotionVideoFact[]
    } | null
    if (!spec) {
      const body = String(await win.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 120) : ""', true))
      throw new Error(`the composition did not load${body ? `: ${body.trim()}` : ''}${pageError ? ` (${pageError})` : ''}`)
    }
    if (!spec.durationInFrames) {
      throw new Error(
        `unknown duration: declare <meta name="orbit-motion" content="duration=…"> or window.orbitMotion.durationInFrames${pageError ? ` (page error: ${pageError})` : ''}`,
      )
    }
    const width = Math.round(spec.width ?? 1920)
    const height = Math.round(spec.height ?? 1080)
    // The viewport must be the composition's: "entered the scene" is being INSIDE it.
    win.setContentSize(width, height)
    const raw = (await win.webContents.executeJavaScript('window.__orbitMotionLayers(900)', true)) as {
      durationInFrames: number
      layers: RawLayer[]
    }
    return {
      width,
      height,
      fps: spec.fps ?? 30,
      durationInFrames: spec.durationInFrames,
      layers: pickLayers(raw.layers ?? [], spec.durationInFrames),
      failedFonts: spec.failedFonts ?? [],
      scriptErrors: spec.scriptErrors ?? [],
      transitions: spec.transitions ?? [],
      scenes: spec.scenes ?? [],
      videos: spec.videos ?? [],
    }
  } catch (err) {
    if (win.isDestroyed()) throw new Error(`the composition did not finish loading in ${LOAD_TIMEOUT_MS / 1000}s`)
    throw err
  } finally {
    clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}
