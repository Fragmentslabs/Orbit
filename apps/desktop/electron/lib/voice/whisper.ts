/**
 * whisper.cpp dictation engine — as a HELPER PROCESS (`whisper-server`).
 *
 * Why a process and not an N-API addon: the lab used the `smart-whisper` binding
 * because it is pure Node, but in an Electron app a native addon suffers with ABI on every
 * Electron update (the lab README explicitly recommends `whisper-server`
 * here). The server is a separate process: it speaks over HTTP, it does not
 * know what V8's ABI is, and if it hangs it does not take the app down.
 *
 * Two measured lab inheritances that are implemented on purpose:
 *
 *  - **explicit greedy**. The lab binding started from `BEAM_SEARCH` (5 beams)
 *    without anyone asking. `whisper-server` decides the strategy by
 *    `beam_size > 1`, so we send `beam_size=1` and `best_of=1` — greedy with a single
 *    path, which is the fastest with the same text (README §17);
 *  - **warm model**. The server loads the model once and keeps it; its
 *    warm-up routine avoids paying for the shader compilation on the
 *    user's first utterance.
 *
 * What does NOT live here: the ggml model (downloaded on demand by `models-store`) and
 * the `whisper-server` binary, compiled at build time (scripts/build-whisper-server.mjs).
 * The binary is looked up, in this order: `ORBIT_WHISPER_SERVER`, the one shipped with the
 * app, `<userData>/voice/whisper/whisper-server` and the PATH. Without it the engine is unavailable with the reason spelled out — instead of
 * failing silently in the middle of an utterance.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { userShellEnv } from '../shell-env'
import type { SttEngine, SttEngineStatus, SttHandle, SttSegment, SttStartInput } from './engine'
import { encodeWavPcm16, SampleBuffer, samplesToMs, STT_SAMPLE_RATE } from './audio'
import { getSttModel, preferredWhisperModelId } from './catalog'
import {
  bundledWhisperServerPath,
  isWhisperModelInstalled,
  localWhisperServerPath,
  modelFileFor,
  modelsDir,
  whisperInstalledIds,
} from './models-store'

const ENGINE_ID = 'whisper'
const ENGINE_LABEL = 'Whisper (whisper.cpp, helper process)'
const DEFAULT_MODEL_ID = 'whisper-base'

/** whisper's fixed window is 30 s: beyond that the live preview makes no sense. */
const MAX_PREVIEW_SAMPLES = STT_SAMPLE_RATE * 30
/** Cadence of the live preview (the step costs ~1.2 s on turbo — §17). */
const PREVIEW_PERIOD_MS = 2000
const READY_TIMEOUT_MS = 120_000
const IDLE_SHUTDOWN_MS = 5 * 60_000

function serverBinaryName(): string {
  return process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
}

/** First existing `dir/name` in the PATH (a GUI app's PATH is lean). */
function findInPath(name: string): string | null {
  const dirs = (userShellEnv().PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

/** Path of the whisper-server binary, or null if there is none. */
export function resolveWhisperServer(): string | null {
  const env = process.env.ORBIT_WHISPER_SERVER
  if (env && fs.existsSync(env)) return env
  const bundled = bundledWhisperServerPath()
  if (bundled && fs.existsSync(bundled)) return bundled
  const local = localWhisperServerPath()
  if (fs.existsSync(local)) return local
  return findInPath(serverBinaryName())
}

function defaultThreads(): number {
  const cpus = os.cpus().length || 4
  return Math.max(2, Math.min(8, cpus - 2))
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port found'))))
    })
  })
}

// ---------------------------------------------------------------------------
// Server per model
// ---------------------------------------------------------------------------

interface WhisperServer {
  modelId: string
  bin: string
  port: number
  proc: ChildProcess
  ready: Promise<void>
  log: string[]
  queue: Promise<unknown>
  idleTimer: NodeJS.Timeout | null
}

const servers = new Map<string, WhisperServer>()
const starting = new Map<string, Promise<WhisperServer>>()

async function waitHealthy(server: WhisperServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (server.proc.exitCode !== null) {
      throw new Error(`whisper-server exited (code ${server.proc.exitCode}): ${server.log.slice(-5).join(' ')}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`)
      if (res.ok) return
    } catch {
      // still starting
    }
    if (Date.now() > deadline) {
      throw new Error(`whisper-server was not ready in ${READY_TIMEOUT_MS / 1000} s`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

function touch(server: WhisperServer): void {
  if (server.idleTimer) clearTimeout(server.idleTimer)
  server.idleTimer = setTimeout(() => shutdownServer(server.modelId), IDLE_SHUTDOWN_MS)
  server.idleTimer.unref?.()
}

function shutdownServer(modelId: string): void {
  const server = servers.get(modelId)
  if (!server) return
  if (server.idleTimer) clearTimeout(server.idleTimer)
  servers.delete(modelId)
  try {
    server.proc.kill()
  } catch {
    // already dead
  }
}

/** Shuts down all servers (the app is exiting). */
export function shutdownWhisperServers(): void {
  for (const id of [...servers.keys()]) shutdownServer(id)
}

// Leaving the app cannot leave the `whisper-server` (and the model loaded in it)
// alive as an orphan process. The `exit` handler only accepts synchronous work, and
// that is exactly what `kill()` is — `shutdownWhisperServers` is for whoever wants
// to take it down earlier (model switch, settings screen).
process.on('exit', () => {
  for (const server of servers.values()) {
    try {
      server.proc.kill()
    } catch {
      // already dead
    }
  }
})

async function ensureServer(modelId: string, threads: number): Promise<WhisperServer> {
  const current = servers.get(modelId)
  if (current && current.proc.exitCode === null) {
    await current.ready
    touch(current)
    return current
  }
  const inFlight = starting.get(modelId)
  if (inFlight) return inFlight

  const bin = resolveWhisperServer()
  if (!bin) throw new Error('whisper-server not found (see the reason in the engine status)')

  const promise = (async () => {
    const def = getSttModel(modelId)
    if (!def) throw new Error(`modelo de ditado desconhecido: ${modelId}`)
    if (!isWhisperModelInstalled(modelId)) throw new Error(`o modelo "${modelId}" is not downloaded`)

    const port = await freePort()
    const proc = spawn(
      bin,
      [
        '-m', modelFileFor(def),
        '-t', String(threads),
        '--host', '127.0.0.1',
        '--port', String(port),
        '-nt', // no timestamps (dictation does not use them)
      ],
      { env: userShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const server: WhisperServer = {
      modelId,
      bin,
      port,
      proc,
      ready: Promise.resolve(),
      log: [],
      queue: Promise.resolve(),
      idleTimer: null,
    }
    const capture = (chunk: Buffer): void => {
      server.log.push(chunk.toString().trim())
      if (server.log.length > 40) server.log.shift()
    }
    proc.stdout?.on('data', capture)
    proc.stderr?.on('data', capture)
    proc.on('error', (err) => capture(Buffer.from(String(err))))
    server.ready = waitHealthy(server)
    servers.set(modelId, server)
    try {
      await server.ready
    } catch (err) {
      shutdownServer(modelId)
      throw err
    }
    touch(server)
    return server
  })().finally(() => starting.delete(modelId))

  starting.set(modelId, promise)
  return promise
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/** Builds the `/inference` multipart (the server only accepts a file, not PCM). */
function inferenceForm(wav: Buffer, language: string, timestamps: boolean | 'words' = false): FormData {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
  // With timings requested, verbose_json brings the segments (start/end in s).
  form.append('response_format', timestamps ? 'verbose_json' : 'json')
  form.append('language', language || 'auto')
  // Explicit greedy: it is `beam_size > 1` that turns beam search on in the server.
  form.append('beam_size', '1')
  form.append('best_of', '1')
  form.append('no_timestamps', timestamps ? 'false' : 'true')
  form.append('temperature', '0')
  // Per word (video editing): one segment per word, split at the
  // word boundary — turns on per-token timings in the server.
  if (timestamps === 'words') {
    form.append('max_len', '1')
    form.append('split_on_word', 'true')
  }
  return form
}

/** Transcribes 16 kHz mono — serialised per server (the context is not reentrant). */
async function transcribe(
  modelId: string,
  threads: number,
  samples: Float32Array,
  language: string,
  timestamps: boolean | 'words' = false,
): Promise<{ text: string; segments?: SttSegment[] }> {
  const server = await ensureServer(modelId, threads)
  const run = server.queue.then(async () => {
    const wav = encodeWavPcm16(samples, STT_SAMPLE_RATE)
    const res = await fetch(`http://127.0.0.1:${server.port}/inference`, {
      method: 'POST',
      body: inferenceForm(wav, language, timestamps),
    })
    if (!res.ok) throw new Error(`o whisper-server respondeu HTTP ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as {
      text?: string
      segments?: { start?: number; end?: number; text?: string; words?: { word?: string; start?: number; end?: number }[] }[]
    }
    const text = String(json.text || '').trim()
    if (!timestamps || !Array.isArray(json.segments)) return { text }
    const segments = json.segments
      .map((seg) => ({
        startMs: Math.round((seg.start ?? 0) * 1000),
        endMs: Math.round((seg.end ?? 0) * 1000),
        text: String(seg.text ?? '').trim(),
        ...(timestamps === 'words'
          ? {
              // With max_len=1 each segment ALREADY is a word; when the server
              // also sends `words`, they are the finer source.
              words: (seg.words?.length
                ? seg.words.map((w) => ({ text: String(w.word ?? ''), start: w.start ?? 0, end: w.end ?? 0 }))
                : [{ text: String(seg.text ?? ''), start: seg.start ?? 0, end: seg.end ?? 0 }]
              )
                .map((w) => ({ startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000), text: w.text.trim() }))
                .filter((w) => w.text),
            }
          : {}),
      }))
      .filter((seg) => seg.text)
    return { text, segments }
  })
  server.queue = run.then(
    () => undefined,
    () => undefined,
  )
  touch(server)
  return run
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface WhisperSession {
  id: string
  modelId: string
  threads: number
  language: string
  live: boolean
  /** File transcribed with timings: the end asks the server for the segments. */
  timestamps: boolean | 'words'
  onPartial: (text: string) => void
  buffer: SampleBuffer
  chain: Promise<unknown>
  gen: number
  stopping: boolean
  cancelled: boolean
  previewTimer: NodeJS.Timeout | null
  lastPreviewSamples: number
}

function enqueue(s: WhisperSession, fn: () => Promise<void>): Promise<void> {
  const run = s.chain.then(fn, fn)
  s.chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function schedulePreview(s: WhisperSession): void {
  if (!s.live || s.stopping || s.cancelled || s.previewTimer) return
  s.previewTimer = setTimeout(() => {
    s.previewTimer = null
    void runPreview(s)
  }, PREVIEW_PERIOD_MS)
  s.previewTimer.unref?.()
}

function runPreview(s: WhisperSession): Promise<void> {
  if (s.stopping || s.cancelled) return Promise.resolve()
  // Beyond 30 s the preview stops (it is whisper's window) and the final one transcribes everything.
  if (s.buffer.samples > MAX_PREVIEW_SAMPLES) return Promise.resolve()
  if (s.buffer.samples === s.lastPreviewSamples) {
    schedulePreview(s)
    return Promise.resolve()
  }
  s.lastPreviewSamples = s.buffer.samples
  const gen = s.gen
  const samples = s.buffer.slice(0, s.buffer.samples)
  if (samples.length < STT_SAMPLE_RATE * 0.3) {
    schedulePreview(s)
    return Promise.resolve()
  }
  return enqueue(s, async () => {
    if (s.stopping || s.cancelled || gen !== s.gen) return
    try {
      const { text } = await transcribe(s.modelId, s.threads, samples, s.language)
      if (s.stopping || s.cancelled || gen !== s.gen || !text) return
      try {
        s.onPartial(text)
      } catch {
        // an error in the caller does not take the session down
      }
    } catch {
      // the preview is best-effort: the final result is what counts
    } finally {
      schedulePreview(s)
    }
  })
}

/**
 * "Automatic" model (null `modelId`): the one that fits the machine when it is on
 * disk, otherwise the default, otherwise the first whisper downloaded. Pinning the default made
 * whoever downloaded only the small one see the microphone enabled and the start fail with
 * "whisper-base not downloaded".
 */
export function whisperAutoModelId(): string {
  const installed = whisperInstalledIds()
  const preferred = preferredWhisperModelId(os.totalmem() / 1024 ** 3)
  for (const id of [preferred, DEFAULT_MODEL_ID]) if (installed.includes(id)) return id
  return installed[0] ?? preferred
}

function resolveModelId(modelId: string | null): string {
  return modelId || whisperAutoModelId()
}

async function status(): Promise<SttEngineStatus> {
  const bin = resolveWhisperServer()
  const installed = whisperInstalledIds()
  const detail: Record<string, unknown> = {
    binary: bin,
    binaryEnv: 'ORBIT_WHISPER_SERVER',
    binaryLocal: localWhisperServerPath(),
    modelsDir: modelsDir(),
    installed,
    defaultModelId: DEFAULT_MODEL_ID,
    decode: 'greedy (beam_size=1, best_of=1)',
  }
  if (!bin) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: installed.length > 0,
      reason:
        'whisper-server not found — run `npm run whisper:build` (apps/desktop), put the binary in ' +
        `${localWhisperServerPath()}, ou defina ORBIT_WHISPER_SERVER`,
      detail,
    }
  }
  if (!installed.length) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: false,
      reason: 'no whisper model downloaded (fetch tiny/base/small/medium/large-v3-turbo on demand)',
      detail,
    }
  }
  return { engine: ENGINE_ID, available: true, installed: true, detail }
}

async function start(input: SttStartInput, onPartial: (text: string) => void): Promise<SttHandle> {
  // Validates the model BEFORE the binary: an id that is not whisper's is an
  // integration error and the specific reason helps more than "the server is missing".
  const modelId = resolveModelId(input.modelId)
  const def = getSttModel(modelId)
  if (!def || def.engine !== 'whisper') throw new Error(`the whisper engine does not have the model "${modelId}"`)

  const bin = resolveWhisperServer()
  if (!bin) {
    const st = await status()
    throw new Error(st.reason || 'whisper-server not found')
  }
  if (!isWhisperModelInstalled(modelId)) throw new Error(`o modelo "${modelId}" is not downloaded`)

  const threads = input.threads ?? defaultThreads()
  const language = input.language || 'pt'

  const s: WhisperSession = {
    id: randomUUID(),
    modelId,
    threads,
    language,
    live: input.live,
    timestamps: input.timestamps || false,
    onPartial,
    buffer: new SampleBuffer(),
    chain: Promise.resolve(),
    gen: 0,
    stopping: false,
    cancelled: false,
    previewTimer: null,
    lastPreviewSamples: 0,
  }
  // Starts the server waiting for the model to load: on failure, the error comes out at start.
  await ensureServer(modelId, threads)

  return {
    pushAudio(samples: Float32Array): void {
      if (s.stopping || s.cancelled) return
      s.buffer.push(samples)
      schedulePreview(s)
    },

    async stop(): Promise<{ text: string; audioMs: number; segments?: SttSegment[] }> {
      s.stopping = true
      s.gen += 1
      if (s.previewTimer) {
        clearTimeout(s.previewTimer)
        s.previewTimer = null
      }
      await s.chain
      const samples = s.buffer.slice(0, s.buffer.samples)
      const audioMs = samplesToMs(samples.length)
      if (samples.length < STT_SAMPLE_RATE * 0.1) return { text: '', audioMs }
      const { text, segments } = await transcribe(modelId, threads, samples, language, s.timestamps)
      return { text, audioMs, segments }
    },

    async cancel(): Promise<void> {
      s.cancelled = true
      s.stopping = true
      s.gen += 1
      if (s.previewTimer) {
        clearTimeout(s.previewTimer)
        s.previewTimer = null
      }
      s.buffer = new SampleBuffer()
    },
  }
}

/**
 * Starts `whisper-server` and loads the model BEFORE first use, so the
 * user's first session does not pay for the `spawn` + the ggml read.
 */
async function warmEngine(modelId: string | null, threads?: number): Promise<void> {
  const id = resolveModelId(modelId)
  const def = getSttModel(id)
  if (!def || def.engine !== ENGINE_ID) return
  try {
    await ensureServer(id, threads ?? defaultThreads())
  } catch {
    // binary or model missing: the reason already shows up in `status()`
  }
}

export const whisperEngine: SttEngine = {
  id: ENGINE_ID,
  label: ENGINE_LABEL,
  defaultModelId: DEFAULT_MODEL_ID,
  status,
  warm: warmEngine,
  // The server already shuts itself down when idle (`touch`/IDLE_SHUTDOWN_MS);
  // this is the facade's explicit trigger.
  release: shutdownWhisperServers,
  start,
}
