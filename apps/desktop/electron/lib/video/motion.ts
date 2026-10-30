import { BrowserWindow, type WebContents } from 'electron'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { probeMedia, runFfmpeg } from './ffmpeg'
import { motionAudioPlan } from './motion-audio'
import { motionVideoAudioTracks, type MotionVideoFact } from './motion-video-audio'
import { lintMotionComposition } from './motion-lint-run'
import {
  assertFrameBytes,
  audioExtractFfmpegArgs,
  bandCount,
  concatFfmpegArgs,
  concatList,
  isAlphaFormat,
  isPlainAudioMix,
  motionAudioFfmpegArgs,
  motionAudioMixFfmpegArgs,
  motionFfmpegArgs,
  motionFormatFor,
  splitBands,
  unpremultiplyBgra,
  type MotionFormat,
  type MotionQuality,
} from './motion-render-args'
import { capturePageReliably } from './capture'
import { MOTION_SPEC } from './motion-runtime'
import type { MotionTransitionInfo } from './motion-transitions'

/**
 * Motion from HTML: Orbit is already a Chromium, so an
 * HTML/CSS/GSAP composition becomes video right here — without downloading headless Chrome, without
 * Remotion (which is source-available and paid for companies) and without network.
 *
 * Deterministic: time does NOT run by itself. For each frame the runtime pauses
 * everything and positions at instant t, waits for the paint and captures. That way a
 * slow frame does not become a jump in the video, and rendering twice gives the same file (in the
 * sequential path, `bands: 1`; see the note about parallel tracks below). What
 * the composition may use to be "seekable":
 *   - `window.orbitMotion = { seek(t) }` (t in seconds; may return a Promise)
 *     — the explicit path, for canvas/three.js/anything;
 *   - `window.orbitTimeline` (a GSAP timeline) or, without it, the
 *     GSAP global timeline;
 *   - CSS animations and Web Animations (document.getAnimations());
 *   - the page's <video> (currentTime + waiting for "seeked").
 * What is NOT seekable (requestAnimationFrame with its own clock, setTimeout)
 * comes out frozen — the video skill explains that to the agent.
 *
 * Two performance decisions, each with its own pitfall:
 *
 *  1. The composition is loaded through the `orbit-motion://` scheme — the SAME path
 *     as the preview — and not through `file://`. The protocol injects the runtime as the
 *     FIRST script of the `<head>`, so a `delayRender()` called during the parse is
 *     captured here just like in the preview; with the runtime injected AFTER the load
 *     (the old path) that composition worked in the preview and came out blank
 *     in the render.
 *  2. The frame goes to ffmpeg RAW (`nativeImage.toBitmap()`, BGRA), without PNG:
 *     one encode in Chromium and one decode in ffmpeg per frame less. The
 *     care (constant size, HiDPI, premultiplied alpha) is in
 *     motion-render-args.ts, where it is pure and tested.
 *
 * PARALLEL TRACKS: [0, N) is split into K tracks, each in its own offscreen
 * window, and the segments are concatenated with `-c copy` (the same as the
 * EDL render). This does NOT promise output byte-identical to the sequential one: each track
 * starts its own GOP, so the keyframes fall at different points. The
 * sequential path (`bands: 1`) is the always-deterministic one.
 */

export interface MotionSpec {
  width?: number
  height?: number
  fps?: number
  duration?: number
}

export interface MotionOptions extends MotionSpec {
  file: string
  output: string
  /** Transparent background: .mov (ProRes 4444) or .webm (VP9 with alpha). */
  transparent?: boolean
  /** Encoder format. Without it, comes from the file extension + transparency. */
  format?: MotionFormat
  /** Id of an ALREADY registered composition (it is what the IPC passes): does not register it again. */
  id?: string
  /** Working folder and session that register the composition (see motion-store). */
  root?: string
  sessionId?: string
  /**
   * Parallel tracks. `1` is the sequential path, frame by frame — the
   * deterministic one. Without it: min(4, max(1, cores/2)).
   */
  bands?: number
  /** File weight (CRF/preset); without it, the usual `balanced`. */
  quality?: MotionQuality
  /**
   * Also deliver the track alone, in WAV, next to the video. It only makes sense
   * when the piece has sound — without tracks, the render creates no file at all.
   */
  separateAudio?: boolean
  /** Called at every CAPTURED frame (not in order: it is the count that went up). */
  onProgress?: (frame: number, total: number) => void
  signal?: AbortSignal
  /**
   * The piece's audio, muxed on a FINAL pass — the capture takes frames, not sound.
   * Without it, the composition's folder is consulted by the conventional name
   * (`audio.mp3`, `audio.wav`…): that is what makes the tab's Render button and the tool
   * reach the same file. The length is the composition's.
   */
  audio?: string
}

/**
 * Render timings, in milliseconds per frame (average of the captured frames).
 * Frozen contract with the `motion_render` tool, which prints these names.
 */
export interface MotionMetrics {
  /** Rendered frames. */
  frames: number
  /** Wall time of the whole render — with K tracks it is smaller than frames × msPerFrame. */
  totalMs: number
  /** Average cost of ONE frame (the sum of the three buckets), independent of K. */
  msPerFrame: number
  /** Average of seek + paint (window.orbitMotion.seek, which waits for the frame to come out). */
  seekPaint: number
  /** Average of capturePage + toBitmap + the alpha unpremultiplication. */
  capture: number
  /** Average of the write to ffmpeg's stdin (encode + IO, with backpressure). */
  encodeWrite: number
}

export interface MotionResult {
  output: string
  /** Muxed audio (explicit or the composition folder's); absent when mute. */
  audio?: string
  /** WAV of the track, when `separateAudio` was requested and the piece has sound. */
  audioPath?: string
  width: number
  height: number
  fps: number
  duration: number
  frames: number
  metrics: MotionMetrics
  warnings: string[]
}

const MAX_SECONDS = 180

/** `<meta name="orbit-motion" content="width=1920,height=1080,fps=30,duration=6">` → spec (pure). */
export function parseMotionMeta(content: string | null | undefined): MotionSpec {
  const spec: MotionSpec = {}
  for (const pair of (content ?? '').split(/[,;]/)) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    const num = Number(v)
    if (!Number.isFinite(num) || num <= 0) continue
    if (k === 'width' || k === 'height' || k === 'fps' || k === 'duration') spec[k] = num
  }
  return spec
}

/** Snapshot of the composition state published by the runtime (see MOTION_SPEC). */
interface MotionPageSpec {
  meta: string | null
  width?: number
  height?: number
  fps?: number
  duration?: number
  durationInFrames?: number
  failedFonts: string[]
  transitions?: MotionTransitionInfo[]
  videos?: MotionVideoFact[]
}

interface CapturedFrame {
  buffer: Buffer
  width: number
  height: number
}

/** Buckets per frame, summed across the tracks. */
interface Counters {
  done: number
  seekPaint: number
  capture: number
  encodeWrite: number
}

/**
 * The composition registry (motion-store) imports THIS module for the IPC
 * render; importing it back at the top would close a module cycle. The
 * dynamic import resolves it on the first render and the module stays cached — it
 * costs nothing per frame.
 */
async function motionRegistry() {
  return import('./motion-store')
}

/** Milliseconds with two decimals: the number goes straight into the tool's report. */
function ms(value: number): number {
  return Math.round(value * 100) / 100
}

function createRenderWindow(width: number, height: number, transparent: boolean): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // NO `partition` on purpose: the `orbit-motion://` scheme handler is
      // registered in the default session (protocol.handle in motion-store) and an own
      // partition does NOT inherit that handle — the composition would answer 404
      // and the frame would come out blank. The tracks also share the session.
    },
  })
  // The composition is a video page, not a browser: no leaving it.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

/**
 * Loads the composition through the scheme — the runtime already entered as the FIRST script of
 * the `<head>`. If it is not there (the entry answered 404, the runtime did not
 * run), the page snapshot comes back null and it is here that we stop, instead of
 * capturing blank frames.
 */
async function loadComposition(win: BrowserWindow, url: string): Promise<MotionPageSpec> {
  await win.loadURL(url)
  // After the fonts: the runtime's failedFonts are read right below and its
  // handler ran before this await.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
  const page = (await win.webContents.executeJavaScript(MOTION_SPEC, true)) as MotionPageSpec | null
  if (!page) throw new Error(`motion runtime did not load in the render window (${url})`)
  return page
}

/** Seek to a frame: the runtime waits for the paint (double rAF) before resolving. */
async function seekFrame(contents: WebContents, frame: number, counters?: Counters): Promise<void> {
  const started = performance.now()
  await contents.executeJavaScript(`window.orbitMotion.seek(${frame})`, true)
  if (counters) counters.seekPaint += performance.now() - started
}

/**
 * The raw bitmap of the window (BGRA, premultiplied) — without going through PNG. In the
 * alpha path it comes out of here with straight color (unpremultiplyBgra).
 */
async function captureBitmap(
  contents: WebContents,
  counters?: Counters,
  alpha = false,
  expected?: { width: number; height: number },
): Promise<CapturedFrame> {
  const started = performance.now()
  let image = await capturePageReliably(contents)
  // On a screen with a fractional scale (125%, 150%) each window rounds the
  // capture size its own way — 1603×902 in one track, 1602×903 in the other —
  // and rawvideo demands the SAME size in every frame. Whatever comes outside the
  // probed size is brought to it (ffmpeg's scale leads to the final size).
  if (expected) {
    const got = image.getSize()
    if (got.width !== expected.width || got.height !== expected.height) {
      image = image.resize({ width: expected.width, height: expected.height, quality: 'best' })
    }
  }
  const size = image.getSize()
  const buffer = image.toBitmap()
  // Chromium's alpha comes PREMULTIPLIED: becoming straight color HERE is the "before the
  // format conversion" — see unpremultiplyBgra (the ffmpeg filter does not handle it).
  if (alpha) unpremultiplyBgra(buffer)
  if (counters) counters.capture += performance.now() - started
  return { buffer, width: size.width, height: size.height }
}

interface BandOptions {
  win: BrowserWindow
  /** Frame range, `[start, end)`. */
  start: number
  end: number
  total: number
  /** File of this track (it is the output itself when there is a single track). */
  target: string
  width: number
  height: number
  fps: number
  format: MotionFormat
  quality?: MotionQuality
  /** Raw frame size, fixed at the probe — the stdin's `-s`. */
  captureWidth: number
  captureHeight: number
  /** Frame 0 already captured at the probe: the first track does not capture it again. */
  probe?: CapturedFrame
  counters: Counters
  onProgress?: (frame: number, total: number) => void
  signal?: AbortSignal
}

/** One track: one offscreen window, one ffmpeg, one segment. */
async function renderBand(o: BandOptions): Promise<void> {
  const input = new PassThrough()
  const encoding = runFfmpeg(
    motionFfmpegArgs({
      width: o.width,
      height: o.height,
      captureWidth: o.captureWidth,
      captureHeight: o.captureHeight,
      fps: o.fps,
      format: o.format,
      quality: o.quality,
      output: o.target,
    }),
    { stdin: input, signal: o.signal },
  )
  // If ffmpeg dies halfway, stop capturing.
  let failed: unknown = null
  encoding.catch((err) => {
    failed = err
  })
  try {
    for (let frame = o.start; frame < o.end; frame++) {
      if (failed) break
      if (o.signal?.aborted) throw new Error('cancelled')
      let captured: CapturedFrame
      if (o.probe && frame === o.start) {
        // Frame 0 came from the probe (which already did its seek and capture):
        // reused, it does not cost a second seek.
        captured = o.probe
      } else {
        await seekFrame(o.win.webContents, frame, o.counters)
        captured = await captureBitmap(o.win.webContents, o.counters, isAlphaFormat(o.format), {
          width: o.captureWidth,
          height: o.captureHeight,
        })
      }
      // A frame of a different size would misalign the whole stdin, silently.
      assertFrameBytes(captured.buffer.length, o.captureWidth, o.captureHeight, frame)
      const started = performance.now()
      if (!input.write(captured.buffer)) await new Promise<void>((r) => input.once('drain', () => r()))
      o.counters.encodeWrite += performance.now() - started
      o.counters.done++
      o.onProgress?.(o.counters.done, o.total)
    }
    input.end()
    await encoding
  } catch (err) {
    input.destroy()
    throw err
  }
}

export async function renderMotion(opts: MotionOptions): Promise<MotionResult> {
  const startedAt = performance.now()
  const warnings: string[] = []
  const registry = await motionRegistry()
  // The render loads the composition through the scheme, and the scheme only serves what is
  // in the registry. The tool only has the file path: it registers here and releases it in the
  // finally. The IPC already passes the id of a registered composition.
  let id = opts.id
  let url: string | null = null
  /** Id that THIS render registered — and only it is released at the end. */
  let registeredId: string | null = null
  if (id) {
    url = await registry.registeredMotionUrl(id)
  } else {
    const registration = await registry.registerMotion(opts.file, undefined, { root: opts.root, sessionId: opts.sessionId })
    id = registration.id
    url = registration.url
    // The composition was already registered (the preview open in the tab): the id is the
    // SAME, and releasing it at the end knocked the tab into a 404 "not found".
    if (registration.created) registeredId = id
  }
  if (!id || !url) throw new Error(`unknown motion composition: ${opts.id ?? opts.file}`)

  const windows: BrowserWindow[] = []
  const counters: Counters = { done: 0, seekPaint: 0, capture: 0, encodeWrite: 0 }
  let work: string | null = null
  const onAbort = () => {
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // After registration: any error from here down goes through the finally (which
    // releases the composition) — including an invalid format in the tool.
    const format = opts.format ?? motionFormatFor(opts.output, Boolean(opts.transparent))
    const alpha = isAlphaFormat(format)
    const primary = createRenderWindow(opts.width ?? 1920, opts.height ?? 1080, alpha)
    windows.push(primary)
    const page = await loadComposition(primary, url)
    const meta = parseMotionMeta(page.meta)
    const width = Math.round(opts.width ?? page.width ?? meta.width ?? 1920)
    const height = Math.round(opts.height ?? page.height ?? meta.height ?? 1080)
    const fps = opts.fps ?? page.fps ?? meta.fps ?? 30
    const duration = opts.duration ?? page.duration ?? meta.duration
    if (!duration) {
      throw new Error(
        'unknown duration: pass `duration`, or declare <meta name="orbit-motion" content="duration=…">, window.orbitMotion.duration or window.orbitTimeline',
      )
    }
    if (duration > MAX_SECONDS) throw new Error(`duration ${duration}s is above the ${MAX_SECONDS}s limit for one composition`)
    if (page.failedFonts.length) {
      warnings.push(`fonts failed to load (the text fell back to another font): ${[...new Set(page.failedFonts)].join(', ')}`)
    }
    primary.setContentSize(width, height)
    // Time runs in FRAMES: the EFFECTIVE fps (which may have come from the options, and
    // not from the page) has to enter the runtime, otherwise the seek converts the frame
    // with the composition's fps and the animation runs at the wrong speed.
    await primary.webContents.executeJavaScript(`window.orbitMotion.fps = ${fps}`, true)

    const total = Math.max(1, Math.round(duration * fps))
    // PROBE: one frame BEFORE starting ffmpeg. Rawvideo demands a
    // constant size and the capture may come at the screen scale (HiDPI, or a document
    // zoom): it is this frame that fixes the stdin's `-s` and, when it is the case,
    // the scale that brings the video back to the final size.
    await seekFrame(primary.webContents, 0)
    const probe = await captureBitmap(primary.webContents, undefined, alpha)
    const bands = splitBands(total, bandCount(opts.bands, os.cpus().length))
    // The piece's audio — whoever chooses the tracks is motion-audio (explicit path,
    // the folder's manifest, or the conventional name). The SAME resolution feeds the
    // tracks the tab draws and plays, so the preview's sound and the final file's
    // are necessarily the same files, at the same instants.
    const folder = path.dirname(path.resolve(opts.file))
    // The sound of the page's <video>s enters as tracks: the runtime mutes them, and without
    // this the speech of a testimony vanished from the final file.
    const videoTracks = await motionVideoAudioTracks(folder, page.videos)
    const { tracks, master } = await motionAudioPlan(folder, opts.audio, videoTracks)
    // The lint of what can be seen BEFORE paying for the render: a wall clock or
    // a random draw would make the file come out different from what the user saw in the tab.
    // Information, never a block — it goes along with the result's warnings.
    const lint = await lintMotionComposition({
      entry: path.resolve(opts.file),
      folder: path.dirname(path.resolve(opts.file)),
      runtime: { fps, durationInFrames: Math.max(1, Math.round(duration * fps)), transitions: page.transitions ?? [] },
      audio: { tracks, master },
    })
    for (const finding of lint) {
      warnings.push(`lint ${finding.severity} ${finding.rule}${finding.line ? ` (line ${finding.line})` : ''}: ${finding.message}${finding.hint ? ` → ${finding.hint}` : ''}`)
    }
    let videoOut = opts.output
    if (bands.length > 1 || tracks.length > 0) {
      // Working folder next to the output, cleaned in the finally — like the EDL render.
      work = await fsp.mkdtemp(path.join(path.dirname(opts.output), '.motion-'))
      // With audio, the video first comes out into a temporary: whoever writes the requested
      // file is the final pass, which only then joins and mixes the sound.
      if (tracks.length > 0) videoOut = path.join(work, `video${path.extname(opts.output) || '.mp4'}`)
    }
    const segments: string[] = []

    await Promise.all(
      bands.map(async (band, index) => {
        let win = primary
        if (index > 0) {
          // Each track has its OWN window: the capture of one does not wait for the other.
          win = createRenderWindow(width, height, alpha)
          windows.push(win)
          await loadComposition(win, url)
          win.setContentSize(width, height)
          await win.webContents.executeJavaScript(`window.orbitMotion.fps = ${fps}`, true)
        }
        const name = `band_${String(index).padStart(3, '0')}${path.extname(opts.output) || '.mp4'}`
        segments[index] = name
        await renderBand({
          win,
          start: band.start,
          end: band.end,
          total,
          target: work ? path.join(work, name) : videoOut,
          width,
          height,
          fps,
          format,
          quality: opts.quality,
          captureWidth: probe.width,
          captureHeight: probe.height,
          probe: index === 0 ? probe : undefined,
          counters,
          onProgress: opts.onProgress,
          signal: opts.signal,
        })
      }),
    )

    if (work) {
      // Concatenation without a second loss (`-c copy`), like the EDL render: the
      // segments already came out with the same encoder parameters.
      await fsp.writeFile(path.join(work, 'list.txt'), concatList(segments))
      await runFfmpeg(concatFfmpegArgs({ listFile: 'list.txt', output: path.resolve(videoOut), format }), {
        cwd: work,
        signal: opts.signal,
      })
    }

    // Audio: FINAL pass, with the video NOT re-encoded (`-c:v copy`). The
    // length is the composition's — the track that goes past the end is cut at it, and the
    // one that ends earlier leaves the rest to the others. What does not fit becomes a WARNING (it is
    // what one reads to know whether the voice fit the piece), never an error.
    if (tracks.length > 0) {
      // Each track is measured before mixing: only with the number in hand can one
      // SAY that one went past the end (and was cut) or that it ended earlier (and left
      // silence) — which is what the agent needs to read in the result.
      for (const track of tracks) {
        const probed = await probeMedia(track.file).catch(() => null)
        const secs = probed ? probed.durationMs / 1000 : 0
        if (secs <= 0) continue
        const endsAt = track.end ?? track.start + secs
        if (endsAt > duration + 0.05) {
          warnings.push(
            `audio "${track.name}" ends at ${endsAt.toFixed(2)}s and the piece is ${duration.toFixed(2)}s — it was cut at the end`,
          )
        } else if (track.end === undefined && endsAt < duration - 0.05) {
          warnings.push(
            `audio "${track.name}" ends at ${endsAt.toFixed(2)}s and the piece is ${duration.toFixed(2)}s — the last ${(duration - endsAt).toFixed(2)}s are silent`,
          )
        }
      }
      // The simple case (one track, the whole piece, no processing) has its own
      // path: one more `-i`, no filter graph. The graph only pays off when
      // there is something to mix.
      const only = tracks.length === 1 ? tracks[0] : null
      const args =
        only && isPlainAudioMix(tracks, master)
          ? motionAudioFfmpegArgs({
              video: videoOut,
              audio: only.file,
              output: path.resolve(opts.output),
              duration,
              format,
            })
          : motionAudioMixFfmpegArgs({
              video: videoOut,
              output: path.resolve(opts.output),
              duration,
              format,
              events: tracks,
              master,
            })
      await runFfmpeg(args, { signal: opts.signal })
    }

    // "Separate audio": extracted from the FINAL FILE, so exactly the sound that
    // is in the video comes out (same mixing, same cut, same finishing) — only the audio is
    // encoded, the picture is not touched. Without tracks, there is nothing to extract: it is
    // a warning, not an error (the person asked for audio of a mute piece).
    let audioPath: string | undefined
    if (opts.separateAudio) {
      if (tracks.length === 0) {
        warnings.push('separate audio was asked for, but the piece has no audio track — no WAV was written')
      } else {
        const wav = `${opts.output.replace(/\.[^./\\]+$/, '')}.wav`
        await runFfmpeg(audioExtractFfmpegArgs({ video: path.resolve(opts.output), output: wav }), {
          signal: opts.signal,
        })
        audioPath = wav
      }
    }

    const metrics: MotionMetrics = {
      frames: total,
      totalMs: ms(performance.now() - startedAt),
      seekPaint: ms(counters.seekPaint / total),
      capture: ms(counters.capture / total),
      encodeWrite: ms(counters.encodeWrite / total),
      msPerFrame: ms((counters.seekPaint + counters.capture + counters.encodeWrite) / total),
    }
    return { output: opts.output, width, height, fps, duration, frames: total, metrics, warnings, audioPath }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
    // Only releases what THIS render registered: the IPC's id belongs to whoever asked.
    if (registeredId) await registry.unregisterMotion(registeredId).catch(() => {})
  }
}