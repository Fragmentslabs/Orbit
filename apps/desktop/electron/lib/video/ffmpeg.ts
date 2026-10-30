import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { addBundledToolDir, userShellEnv } from '../shell-env'

/**
 * The ffmpeg/ffprobe that Orbit ships with (scripts/fetch-ffmpeg.mjs): static
 * builds with libx264, libass and freetype — what the EDL render needs.
 *
 * Looked up in this order: `ORBIT_FFMPEG_DIR` (folder with both), the one that comes with
 * the app (`Resources/ffmpeg` when packaged, `resources/ffmpeg/<platform>-<arch>`
 * in dev) and, last, the user's PATH. With none of them, the video tools do not even
 * show up for the agent.
 */

const EXE = process.platform === 'win32' ? '.exe' : ''

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
  /** Where it came from: the app's, the env's or the system's. */
  source: 'bundled' | 'env' | 'path'
}

function bundledDir(): string | null {
  // `app` missing = outside Electron (tests that mock the module).
  if (!app) return null
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg')
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : null
  if (!appPath) return null
  return path.join(appPath, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
}

function pairIn(dir: string | null | undefined): { ffmpeg: string; ffprobe: string } | null {
  if (!dir) return null
  const ffmpeg = path.join(dir, `ffmpeg${EXE}`)
  const ffprobe = path.join(dir, `ffprobe${EXE}`)
  return fs.existsSync(ffmpeg) && fs.existsSync(ffprobe) ? { ffmpeg, ffprobe } : null
}

function findInPath(name: string): string | null {
  const env = userShellEnv()
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  for (const dir of (env[key] ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name + EXE)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // keeps looking
    }
  }
  return null
}

let cached: FfmpegPaths | null | undefined

export function resolveFfmpeg(): FfmpegPaths | null {
  if (cached !== undefined) return cached
  const fromEnv = pairIn(process.env.ORBIT_FFMPEG_DIR)
  const bundled = pairIn(bundledDir())
  if (fromEnv) cached = { ...fromEnv, source: 'env' }
  else if (bundled) cached = { ...bundled, source: 'bundled' }
  else {
    const ffmpeg = findInPath('ffmpeg')
    const ffprobe = findInPath('ffprobe')
    cached = ffmpeg && ffprobe ? { ffmpeg, ffprobe, source: 'path' } : null
  }
  return cached
}

/**
 * Called at startup: puts the app's ffmpeg folder on the PATH of the
 * agent's shells, so `bash` also finds `ffmpeg` in the cases the EDL does not cover.
 */
export function registerBundledFfmpeg(): void {
  const found = resolveFfmpeg()
  if (found && found.source !== 'path') addBundledToolDir(path.dirname(found.ffmpeg))
}

export function requireFfmpeg(): FfmpegPaths {
  const found = resolveFfmpeg()
  if (!found) throw new Error('ffmpeg is not available (it ships with the app; set ORBIT_FFMPEG_DIR or install ffmpeg in PATH)')
  return found
}

export interface RunOptions {
  signal?: AbortSignal
  /** Expected total output time (ms) — drives the progress through `-progress`. */
  durationMs?: number
  onProgress?: (fraction: number) => void
  /** Bytes for stdin (e.g. PNG frames of a composition). */
  stdin?: NodeJS.ReadableStream
  cwd?: string
}

export interface RunResult {
  stdout: Buffer
  stderr: string
}

/** Last lines of stderr: that is where ffmpeg says what went wrong. */
function tail(text: string, lines = 12): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n')
}

function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: userShellEnv(),
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out: Buffer[] = []
    let err = ''
    let progressBuf = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (!opts.onProgress) {
        out.push(chunk)
        return
      }
      // With progress, stdout is the `-progress pipe:1` channel (key=value).
      progressBuf += chunk.toString()
      const lines = progressBuf.split('\n')
      progressBuf = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim())
        if (m && opts.durationMs) opts.onProgress(Math.min(1, Number(m[1]) / 1000 / opts.durationMs))
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString()
      // Keeps only the tail: a long render writes megabytes of statistics.
      if (err.length > 200_000) err = err.slice(-100_000)
    })
    if (opts.stdin && proc.stdin) {
      opts.stdin.pipe(proc.stdin)
      proc.stdin.on('error', () => {
        // ffmpeg closed the input (its error shows up in stderr)
      })
    }
    const onAbort = () => proc.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err })
      else reject(new Error(`${path.basename(bin)} exited with code ${code}:\n${tail(err)}`))
    })
  })
}

/** Runs ffmpeg (always with -y, no banner, without reading the keyboard). */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const progress = opts.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []
  return run(requireFfmpeg().ffmpeg, ['-hide_banner', '-nostdin', '-y', ...progress, ...args], opts)
}

export function runFfprobe(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(requireFfmpeg().ffprobe, ['-hide_banner', ...args], opts)
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface VideoStreamInfo {
  index: number
  codec: string
  width: number
  height: number
  fps: number
  /** Display rotation (phone video recorded upright). */
  rotation: number
  pixFmt?: string
}

export interface AudioStreamInfo {
  index: number
  codec: string
  sampleRate: number
  channels: number
}

export interface MediaProbe {
  file: string
  durationMs: number
  sizeBytes: number
  format: string
  video: VideoStreamInfo[]
  audio: AudioStreamInfo[]
  /** Width/height as they appear on screen (rotation applied). */
  display?: { width: number; height: number }
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0
  const [n, d] = rate.split('/').map(Number)
  if (!d) return n || 0
  return Math.round((n / d) * 1000) / 1000
}

interface RawStream {
  index: number
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  pix_fmt?: string
  sample_rate?: string
  channels?: number
  tags?: Record<string, string>
  side_data_list?: Array<{ rotation?: number }>
  disposition?: { attached_pic?: number }
}

/** Turns ffprobe's JSON output into the summary the tools use (pure). */
export function summarizeProbe(file: string, json: { format?: Record<string, string>; streams?: RawStream[] }): MediaProbe {
  const streams = json.streams ?? []
  const video = streams
    // mp3/m4a cover art comes as a one-frame video stream.
    .filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
    .map((s) => {
      const rotation = Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0)
      return {
        index: s.index,
        codec: s.codec_name ?? '?',
        width: s.width ?? 0,
        height: s.height ?? 0,
        fps: parseRate(s.avg_frame_rate) || parseRate(s.r_frame_rate),
        rotation: ((rotation % 360) + 360) % 360,
        pixFmt: s.pix_fmt,
      }
    })
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({ index: s.index, codec: s.codec_name ?? '?', sampleRate: Number(s.sample_rate ?? 0), channels: s.channels ?? 0 }))
  const first = video[0]
  const display = first
    ? first.rotation === 90 || first.rotation === 270
      ? { width: first.height, height: first.width }
      : { width: first.width, height: first.height }
    : undefined
  return {
    file,
    durationMs: Math.round(Number(json.format?.duration ?? 0) * 1000),
    sizeBytes: Number(json.format?.size ?? 0),
    format: json.format?.format_name ?? '?',
    video,
    audio,
    display,
  }
}

export async function probeMedia(file: string): Promise<MediaProbe> {
  const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
  return summarizeProbe(file, JSON.parse(stdout.toString('utf8')))
}

/**
 * Audio of the file as 16 kHz mono PCM16 — the format of the dictation engines.
 * Works for any container ffmpeg opens (mp4, mov, mkv, webm…).
 */
export async function extractPcm16k(file: string, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
  const { stdout } = await runFfmpeg(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], opts)
  return stdout
}
