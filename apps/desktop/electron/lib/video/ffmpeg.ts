import { app } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { addBundledToolDir, userShellEnv } from '../shell-env'

/**
 * O ffmpeg/ffprobe que o Orbit leva junto (scripts/fetch-ffmpeg.mjs): builds
 * estáticos com libx264, libass e freetype — o que o render do EDL precisa.
 *
 * Procurado nesta ordem: `ORBIT_FFMPEG_DIR` (pasta com os dois), o que vem com
 * o app (`Resources/ffmpeg` empacotado, `resources/ffmpeg/<plataforma>-<arch>`
 * no dev) e, por último, o PATH do usuário. Sem nenhum, as tools de vídeo nem
 * aparecem para o agente.
 */

const EXE = process.platform === 'win32' ? '.exe' : ''

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
  /** De onde veio: o do app, o do env ou o do sistema. */
  source: 'bundled' | 'env' | 'path'
}

function bundledDir(): string | null {
  // `app` ausente = fora do Electron (testes que mockam o módulo).
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
      // segue procurando
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
 * Chamado na partida: põe a pasta do ffmpeg do app no PATH dos shells do
 * agente, para o `bash` achar `ffmpeg` também nos casos que o EDL não cobre.
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
  /** Tempo total esperado da saída (ms) — liga o progresso pelo `-progress`. */
  durationMs?: number
  onProgress?: (fraction: number) => void
  /** Bytes para o stdin (ex.: quadros PNG de uma composição). */
  stdin?: NodeJS.ReadableStream
  cwd?: string
}

export interface RunResult {
  stdout: Buffer
  stderr: string
}

/** Últimas linhas do stderr: é onde o ffmpeg diz o que deu errado. */
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
      // Com progresso, o stdout é o canal do `-progress pipe:1` (chave=valor).
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
      // Guarda só o fim: um render longo escreve megabytes de estatística.
      if (err.length > 200_000) err = err.slice(-100_000)
    })
    if (opts.stdin && proc.stdin) {
      opts.stdin.pipe(proc.stdin)
      proc.stdin.on('error', () => {
        // o ffmpeg fechou a entrada (erro dele aparece no stderr)
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

/** Roda o ffmpeg (sempre com -y, sem banner, sem ler o teclado). */
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
  /** Rotação de exibição (vídeo de celular gravado em pé). */
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
  /** Largura/altura como aparecem na tela (rotação aplicada). */
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

/** Converte a saída JSON do ffprobe no resumo que as tools usam (puro). */
export function summarizeProbe(file: string, json: { format?: Record<string, string>; streams?: RawStream[] }): MediaProbe {
  const streams = json.streams ?? []
  const video = streams
    // Capa de mp3/m4a vem como stream de vídeo de um quadro só.
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
 * Áudio do arquivo como PCM16 mono a 16 kHz — o formato dos motores de ditado.
 * Serve para qualquer contêiner que o ffmpeg abre (mp4, mov, mkv, webm…).
 */
export async function extractPcm16k(file: string, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
  const { stdout } = await runFfmpeg(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], opts)
  return stdout
}
