import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, desktopCapturer, session, type DesktopCapturerSource } from 'electron'
import { resolveFfmpeg } from '../video/ffmpeg'
import { addVideoToGallery } from '../video/video-gallery'
import { buildFilter, DEFAULT_PLAN, formatTimeline, planRecording, type RecordedAction, type RecordedMark, type RecordingPlan } from './recording-plan'
import { ComputerError, type AppInfo, type Frame, type WindowInfo } from './types'

/**
 * Gravação de uma janela durante o Computer Use. A captura é do próprio
 * Electron: `desktopCapturer` acha a janela pelo CGWindowID e uma janela
 * oculta grava o stream com o MediaRecorder (ScreenCaptureKit por baixo — a
 * janela sai inteira mesmo coberta por outras; medido na Fase 0). O arquivo
 * bruto cresce em disco a cada segundo; no fim, o ffmpeg corta o tempo ocioso
 * (ver recording-plan.ts) e desenha o pulso de clique no alvo de cada ação.
 */

const PARTITION = 'orbit-computer-recorder'
/** Tempo máximo de uma gravação: a janela oculta não pode gravar para sempre. */
const MAX_RECORDING_MS = 20 * 60_000

interface ActiveRecording {
  sessionId: string
  app: AppInfo
  window: WindowInfo
  recorder: BrowserWindow
  raw: string
  name: string
  /** Relógio do main quando o MediaRecorder começou */
  startedAt: number
  video: { width: number; height: number }
  actions: RecordedAction[]
  marks: RecordedMark[]
  poll: NodeJS.Timeout
  limit: NodeJS.Timeout
  writing: Promise<void>
}

const active = new Map<string, ActiveRecording>()
let pendingSource: DesktopCapturerSource | null = null
let handlerReady = false

function recordingsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'recordings')
}

/** Página do gravador: precisa ser arquivo — uma página data: não é contexto seguro e não tem mediaDevices. */
const RECORDER_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
let recorder = null, stream = null, chunks = []
async function toBase64(blobs) {
  if (!blobs.length) return ''
  const buf = new Uint8Array(await new Blob(blobs).arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  return btoa(bin)
}
window.__start = async (fps, bitrate) => {
  stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false })
  const settings = stream.getVideoTracks()[0].getSettings()
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate })
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
  await new Promise((ok) => { recorder.onstart = ok; recorder.start(1000) })
  return { mime, width: settings.width, height: settings.height }
}
window.__take = async () => { const taken = chunks; chunks = []; return toBase64(taken) }
window.__stop = async () => {
  if (recorder && recorder.state !== 'inactive') await new Promise((ok) => { recorder.onstop = ok; recorder.stop() })
  if (stream) stream.getTracks().forEach((t) => t.stop())
  const taken = chunks; chunks = []
  return toBase64(taken)
}
</script></body></html>`

let recorderPage: Promise<string> | null = null
function ensureRecorderPage(): Promise<string> {
  recorderPage ??= (async () => {
    const dir = path.join(os.tmpdir(), 'orbit-computer')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'recorder.html')
    await fsp.writeFile(file, RECORDER_HTML, 'utf8')
    return file
  })()
  return recorderPage
}

function ensureHandler(): void {
  if (handlerReady) return
  handlerReady = true
  // Quem decide QUAL janela é o main (a fonte escolhida no start): a página só
  // pede "a tela", sem seletor do sistema.
  session.fromPartition(PARTITION).setDisplayMediaRequestHandler((_request, callback) => {
    if (pendingSource) callback({ video: pendingSource })
    else callback({})
  })
}

export function isRecording(sessionId: string): boolean {
  return active.has(sessionId)
}

export function recordingWindowId(sessionId: string): number | null {
  return active.get(sessionId)?.window.id ?? null
}

export async function startRecording(input: { sessionId: string; app: AppInfo; window: WindowInfo; name?: string; fps?: number }): Promise<{ width: number; height: number }> {
  if (active.has(input.sessionId)) throw new ComputerError('badRequest', 'A recording is already running in this conversation — call cu_record_stop first.')
  if (active.size > 0) throw new ComputerError('unavailable', 'Another conversation is recording the screen right now.')
  if (!resolveFfmpeg()) throw new ComputerError('unavailable', 'Recording needs the bundled ffmpeg, which is missing from this build.')

  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
  const source = sources.find((s) => s.id.startsWith(`window:${input.window.id}:`))
  if (!source) {
    throw new ComputerError('windowNotFound', 'macOS did not offer that window for capture (minimized, on another Space, or Screen Recording is not granted). Bring it up and try again.')
  }
  ensureHandler()
  pendingSource = source
  const recorder = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, backgroundThrottling: false } })
  try {
    await recorder.loadFile(await ensureRecorderPage())
    const fps = input.fps ?? 30
    const meta = (await recorder.webContents.executeJavaScript(`window.__start(${fps}, 8000000)`)) as { mime: string; width: number; height: number }
    const startedAt = Date.now()
    await fsp.mkdir(recordingsDir(), { recursive: true })
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
    const name = (input.name ?? `computer-${input.app.name}`).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60)
    const raw = path.join(recordingsDir(), `${name}-${stamp}.raw.${meta.mime.includes('mp4') ? 'mp4' : 'webm'}`)
    await fsp.writeFile(raw, Buffer.alloc(0))
    const rec: ActiveRecording = {
      sessionId: input.sessionId,
      app: input.app,
      window: input.window,
      recorder,
      raw,
      name,
      startedAt,
      video: { width: meta.width, height: meta.height },
      actions: [],
      marks: [],
      writing: Promise.resolve(),
      // O bruto vai para o disco a cada segundo: uma gravação longa não fica na memória.
      poll: setInterval(() => {
        rec.writing = rec.writing.then(() => flush(rec)).catch(() => undefined)
      }, 1000),
      limit: setTimeout(() => void stopRecording(input.sessionId).catch(() => undefined), MAX_RECORDING_MS),
    }
    active.set(input.sessionId, rec)
    return rec.video
  } catch (err) {
    if (!recorder.isDestroyed()) recorder.destroy()
    throw err instanceof ComputerError ? err : new ComputerError('bridgeError', `Could not start the recording: ${(err as Error).message}`)
  } finally {
    pendingSource = null
  }
}

async function flush(rec: ActiveRecording, final = false): Promise<void> {
  if (rec.recorder.isDestroyed()) return
  const b64 = (await rec.recorder.webContents.executeJavaScript(final ? 'window.__stop()' : 'window.__take()')) as string
  if (b64) await fsp.appendFile(rec.raw, Buffer.from(b64, 'base64'))
}

/** Ação do agente durante a gravação, no relógio do main. */
export function noteRecordedAction(
  sessionId: string,
  action: { startedAt: number; endedAt: number; label: string; hold?: boolean; target?: RecordedAction['target']; window?: Frame },
): void {
  const rec = active.get(sessionId)
  if (!rec) return
  rec.actions.push({
    start: action.startedAt - rec.startedAt,
    end: action.endedAt - rec.startedAt,
    label: action.label,
    hold: action.hold,
    target: action.target,
    window: action.window ?? rec.window.frame,
  })
}

export function markRecording(sessionId: string, label: string): number | null {
  const rec = active.get(sessionId)
  if (!rec) return null
  const at = Date.now() - rec.startedAt
  rec.marks.push({ at, label })
  return at
}

export interface FinishedRecording {
  file: string
  plan: RecordingPlan
  timeline: string
  recordedMs: number
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split('\n').slice(-3).join(' ') || err.message))
      else resolve()
    })
  })
}

/**
 * Para a gravação e monta o vídeo final: trechos das ações (com respiro),
 * sem o tempo ocioso, com o pulso de clique no alvo de cada ação.
 */
export async function stopRecording(sessionId: string, options: { keepIdle?: boolean; pulses?: boolean } = {}): Promise<FinishedRecording> {
  const rec = active.get(sessionId)
  if (!rec) throw new ComputerError('badRequest', 'There is no recording running in this conversation.')
  active.delete(sessionId)
  clearInterval(rec.poll)
  clearTimeout(rec.limit)
  const stoppedAt = Date.now()
  try {
    await rec.writing
    await flush(rec, true)
  } finally {
    if (!rec.recorder.isDestroyed()) rec.recorder.destroy()
  }
  const recordedMs = stoppedAt - rec.startedAt
  const plan = planRecording(rec.actions, rec.marks, recordedMs, rec.video, { ...DEFAULT_PLAN, keepIdle: options.keepIdle })
  if (options.pulses === false) plan.pulses = []
  const ff = resolveFfmpeg()
  if (!ff) throw new ComputerError('unavailable', 'Recording needs the bundled ffmpeg, which is missing from this build.')
  const output = rec.raw.replace(/\.raw\.(mp4|webm)$/, '.mp4')
  const { filter, output: label } = buildFilter(plan)
  try {
    await run(ff.ffmpeg, [
      '-y', '-v', 'error', '-i', rec.raw,
      '-filter_complex', filter, '-map', `[${label}]`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      output,
    ])
  } catch (err) {
    throw new ComputerError('bridgeError', `Could not assemble the video (the raw take is kept at ${rec.raw}): ${(err as Error).message}`)
  }
  await fsp.rm(rec.raw, { force: true })
  return { file: output, plan, timeline: formatTimeline(plan), recordedMs }
}

/**
 * Fim do controle sem cu_record_stop (fim do turno, Parar, ⌘⇧.): monta assim
 * mesmo e guarda na galeria — o que foi gravado não se perde.
 */
export async function finishOrphanRecording(sessionId: string): Promise<void> {
  if (!active.has(sessionId)) return
  try {
    const done = await stopRecording(sessionId)
    await addVideoToGallery({ file: done.file, name: path.basename(done.file, '.mp4'), sessionId, source: 'script' })
  } catch (err) {
    console.warn('[computer] gravação sem cu_record_stop não pôde ser montada:', err)
  }
}

export async function disposeRecordings(): Promise<void> {
  for (const id of [...active.keys()]) await stopRecording(id).catch(() => undefined)
}
