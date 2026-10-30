import { app, utilityProcess, type UtilityProcess } from "electron"
import path from "node:path"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { isModelDownloaded, modelDir } from "./download"
import { TTS_MAX_CHARS, TTS_MODEL_ID, TTS_STEPS } from "./manifest"

/**
 * Client for the Supertonic 3 engine — the child process that synthesises speech.
 *
 * Inference NEVER runs in the main: it is CPU-bound and takes seconds per chunk,
 * which would freeze the windows and the IPC. Only the client lives here: it starts the engine
 * (`voice-engine/engine.mjs`) with `utilityProcess.fork`, sends the requests and
 * returns the audio chunk by chunk as it arrives.
 *
 * The engine is expensive to start (reads ~400 MB of ONNX, keeps ~0.5 GB in memory) and
 * cheap to keep warm between utterances — so it stays up while it is
 * being used and shuts itself down after an idle period.
 *
 * The channel is the MessagePort (`child.postMessage` / `child.on("message")`), because
 * Electron's `utilityProcess.fork` does not accept stdin as a pipe. The message
 * format is the lab's: `{start}`, one per chunk `{i,n,text,sr,audioMs,
 * synthMs,pcm:<base64 PCM16>}` and the `{done}` at the end.
 */

/** A finished speech chunk, already decoded to 16-bit PCM. */
export interface TtsChunk {
  id: string
  /** Chunk index (0-based) and total chunks of the request. */
  i: number
  n: number
  /** Text that generated THIS chunk (what the sentence-end cut produced). */
  text: string
  /** PCM rate — the one in the contract: 24000 Hz. */
  sr: number
  pcm: Buffer
  audioMs: number
  synthMs: number
  /** ms from the request start until this chunk was ready. */
  firstMs: number
}

export interface TtsSpeakOptions {
  /** M1–M5 / F1–F5 (the engine default is F2). */
  voice?: string
  /** `pt`, `en`, … or `na` (agnostic). */
  lang?: string
  /** Speed factor, 0.5–2.0 (1 = natural). */
  speed?: number
  /** Denoising steps (default 8). */
  steps?: number
  /** Target characters per chunk (the actual cut is always at a sentence end). */
  maxChars?: number
}

export interface TtsSpeakResult {
  pieces: number
  audioMs: number
  /** Total request time, including the wait in the inference queue. */
  ms: number
  rtf: number | null
  /** true when the `signal` aborted the request (it is not an error). */
  cancelled: boolean
}

export interface TtsStatus {
  /** The engine process is up and ready. */
  running: boolean
  /** The model package is downloaded and complete (TTS has no extraction). */
  installed: boolean
  /** Starting up (loading the ONNX). */
  starting: boolean
  /** Utterances in progress. */
  pending: number
  pid: number | null
  /** Last lines of the engine's stderr — diagnostics for the packaged app. */
  log: string[]
}

/** Unused for this long, the engine shuts down (returns ~0.5 GB of RAM). */
const IDLE_SHUTDOWN_MS = 5 * 60_000
/** Reading 400 MB of ONNX from disk: generous, it is a single read. */
const READY_TIMEOUT_MS = 120_000
/** An utterance with NO new engine message is considered stuck. */
const STALL_TIMEOUT_MS = 120_000
/** Wait for `shutdown` before killing the process. */
const GRACE_MS = 2_000
const LOG_LINES = 40

/** Engine messages (engine.mjs). Only the fields the client uses. */
interface EngineMessage {
  type?: "ready" | "status" | "error"
  message?: string
  fatal?: boolean
  ready?: boolean
  bootMs?: number
  id?: string
  start?: boolean
  done?: boolean
  error?: string
  cancelled?: boolean
  i?: number
  n?: number
  text?: string
  sr?: number
  audioMs?: number
  synthMs?: number
  firstMs?: number
  pcm?: string
  pieces?: number
  wallMs?: number
  rtf?: number | null
}

interface Pending {
  resolve: (result: TtsSpeakResult) => void
  reject: (err: Error) => void
  onChunk: (chunk: TtsChunk) => void
  audioMs: number
  pieces: number
  startedAt: number
  /** Restarted on every message: a stuck request does not hang forever. */
  stall: NodeJS.Timeout | null
}

let child: UtilityProcess | null = null
/** Engine ready to receive utterances. */
let ready = false
/** Boot in progress: concurrent calls share this promise. */
let starting: Promise<void> | null = null
let idleTimer: NodeJS.Timeout | null = null
/** The main requested the shutdown: the exit is not a failure. */
let stopping = false
const pending = new Map<string, Pending>()
const logLines: string[] = []

function pushLog(line: string): void {
  const text = line.trimEnd()
  if (!text) return
  logLines.push(text)
  if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES)
  console.log(`[voice-engine] ${text}`)
}

/**
 * Folder of the bundled engine. The main runs from `dist-electron`, so APP_ROOT is the
 * app root in both modes (in dev: apps/desktop; packaged: the app.asar) and the
 * engine directory is shipped along — with no model weight inside.
 */
function engineFile(): string {
  const root = process.env.APP_ROOT ?? app.getAppPath()
  return path.join(root, "electron", "voice-engine", "engine.mjs")
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/** Reschedules the idle shutdown (only with the engine up and no utterance). */
function scheduleIdleShutdown(): void {
  clearIdleTimer()
  if (!child || pending.size > 0) return
  idleTimer = setTimeout(() => {
    if (pending.size === 0) shutdownTts()
  }, IDLE_SHUTDOWN_MS)
  idleTimer.unref?.()
}

/** Rejects all utterances in progress (the engine died or did not come up). */
function failAll(reason: string): void {
  for (const [id, entry] of pending) {
    if (entry.stall) clearTimeout(entry.stall)
    pending.delete(id)
    entry.reject(new Error(reason))
  }
}

function onEngineMessage(message: EngineMessage): void {
  if (!message || typeof message !== "object") return
  if (message.type === "ready") {
    pushLog(`[voice] engine ready in ${message.bootMs ?? 0} ms`)
    return
  }
  if (message.type === "error") {
    pushLog(`[voice][error] ${message.message ?? "engine error"}`)
    return
  }
  if (message.type === "status") return

  const id = String(message.id ?? "")
  const entry = pending.get(id)
  // Message for an already resolved request (cancelled by the user): just the engine
  // finishing what it had started — there is nobody to deliver to.
  if (!entry) return

  if (entry.stall) clearTimeout(entry.stall)

  if (message.i !== undefined && message.pcm !== undefined) {
    entry.pieces = message.n ?? entry.pieces
    entry.audioMs += message.audioMs ?? 0
    entry.stall = setTimeout(() => {
      pending.delete(id)
      // With nobody waiting, the engine goes back to the idle countdown — otherwise
      // a stuck request would keep the ~0.5 GB process alive forever.
      scheduleIdleShutdown()
      entry.reject(new Error("o motor de voz parou de responder no meio da fala"))
    }, STALL_TIMEOUT_MS)
    entry.onChunk({
      id,
      i: message.i,
      n: message.n ?? 1,
      text: message.text ?? "",
      sr: message.sr ?? 24000,
      pcm: Buffer.from(message.pcm, "base64"),
      audioMs: message.audioMs ?? 0,
      synthMs: message.synthMs ?? 0,
      firstMs: message.firstMs ?? 0,
    })
    return
  }

  if (message.done) {
    pending.delete(id)
    scheduleIdleShutdown()
    if (message.error) {
      entry.reject(new Error(message.error))
      return
    }
    entry.resolve({
      pieces: message.pieces ?? entry.pieces,
      audioMs: message.audioMs ?? entry.audioMs,
      ms: message.wallMs ?? Date.now() - entry.startedAt,
      rtf: message.rtf ?? null,
      cancelled: Boolean(message.cancelled),
    })
  }
}

/** Starts the engine and waits for `ready`. Always the same promise while it starts. */
function startEngine(): Promise<void> {
  if (child && ready) return Promise.resolve()
  if (starting) return starting

  starting = new Promise<void>((resolve, reject) => {
    let settled = false
    const proc = utilityProcess.fork(engineFile(), ["--assets", modelDir(TTS_MODEL_ID)], {
      stdio: "pipe",
      // The same heap headroom as in the lab: inference converts the tensors
      // into JS arrays at every denoising step, and the larger chunk weighs on it.
      execArgv: ["--max-old-space-size=4096"],
    })
    child = proc
    stopping = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`the voice engine was not ready in ${Math.round(READY_TIMEOUT_MS / 1000)}s`))
    }, READY_TIMEOUT_MS)

    proc.stdout?.on("data", (chunk: Buffer) => pushLog(chunk.toString()))
    proc.stderr?.on("data", (chunk: Buffer) => pushLog(chunk.toString()))

    proc.on("message", (message: EngineMessage) => {
      if (message?.type === "ready" && !settled) {
        settled = true
        clearTimeout(timeout)
        ready = true
        scheduleIdleShutdown()
        resolve()
      }
      onEngineMessage(message)
    })

    proc.on("exit", (code) => {
      if (child === proc) child = null
      ready = false
      clearIdleTimer()
      const askedByApp = stopping
      stopping = false
      if (!settled) {
        // Died before becoming ready (missing model, ONNX binding…) —
        // the engine's message has already gone to the log.
        settled = true
        clearTimeout(timeout)
        reject(new Error(`the voice engine exited while starting (code ${code})`))
      }
      // A dead process answers nothing anymore: pending items become errors, even
      // when the exit was requested (idle shutdown with a live utterance).
      failAll(`the voice engine exited (code ${code})`)
      pushLog(`[voice] engine exited (code ${code})${askedByApp ? " (requested by the app)" : ""}`)
    })
  }).finally(() => {
    starting = null
  })

  return starting
}

/**
 * Synthesises `text` and delivers the audio in chunks.
 *
 * `onChunk` is called in chunk order; the return only arrives at the end (or with
 * `cancelled: true` when the `signal` aborts — then the engine stops between chunks and
 * nothing else is delivered).
 */
export async function speak(
  text: string,
  options: TtsSpeakOptions = {},
  onChunk: (chunk: TtsChunk) => void,
  signal?: AbortSignal,
): Promise<TtsSpeakResult> {
  const spoken = String(text ?? "").trim()
  if (!spoken) throw new Error("nothing to synthesize: the text is empty")
  if (!(await isModelDownloaded(TTS_MODEL_ID))) {
    throw new Error("the TTS models have not been downloaded yet (Settings → Voice)")
  }
  if (signal?.aborted) return { pieces: 0, audioMs: 0, ms: 0, rtf: null, cancelled: true }

  await startEngine()
  const proc = child
  if (!proc) throw new Error("the voice engine is not up")

  const id = randomUUID()
  return await new Promise<TtsSpeakResult>((resolve, reject) => {
    // `settled` closes the request only once: without it, a `signal` aborting
    // AFTER the end would send a cancel to the engine for an id that no longer
    // exists (the engine's `cancelledIds` would grow for nothing).
    let settled = false
    const entry: Pending = {
      resolve: (result) => {
        settled = true
        resolve(result)
      },
      reject: (err) => {
        settled = true
        reject(err)
      },
      onChunk,
      audioMs: 0,
      pieces: 0,
      startedAt: Date.now(),
      stall: null,
    }
    pending.set(id, entry)
    clearIdleTimer()

    entry.stall = setTimeout(() => {
      pending.delete(id)
      try {
        proc.postMessage({ cmd: "cancel", id })
      } catch {
        // engine is already gone
      }
      scheduleIdleShutdown()
      reject(new Error("the voice engine did not start answering in time"))
    }, STALL_TIMEOUT_MS)

    const onAbort = () => {
      if (settled) return
      // The engine checks for cancellation between chunks (and does not send the chunk it
      // was inferring); the cancelled `done` arrives right after and resolves the
      // request as `cancelled`.
      try {
        proc.postMessage({ cmd: "cancel", id })
      } catch {
        // engine is already gone
      }
    }
    if (signal) {
      if (signal.aborted) {
        pending.delete(id)
        if (entry.stall) clearTimeout(entry.stall)
        resolve({ pieces: 0, audioMs: 0, ms: 0, rtf: null, cancelled: true })
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    try {
      proc.postMessage({
        id,
        cmd: "speak",
        text: spoken,
        voice: options.voice,
        lang: options.lang,
        speed: options.speed,
        steps: options.steps ?? TTS_STEPS,
        maxChars: options.maxChars ?? TTS_MAX_CHARS,
      })
    } catch (err) {
      pending.delete(id)
      if (entry.stall) clearTimeout(entry.stall)
      reject(new Error(`could not talk to the voice engine: ${(err as Error).message}`))
    }
  })
}

/** Engine state (for `voice:status` and for diagnostics). */
export async function ttsStatus(): Promise<TtsStatus> {
  return {
    running: Boolean(child) && ready,
    installed: await isModelDownloaded(TTS_MODEL_ID),
    starting: starting !== null,
    pending: pending.size,
    pid: child?.pid ?? null,
    log: [...logLines],
  }
}

/** Is the bundled engine on disk? (the file comes with the build, it is not downloaded). */
export function enginePresent(): boolean {
  return existsSync(engineFile())
}

/** Shuts the engine down: a polite `shutdown` and, if it does not exit, `kill`. */
export function shutdownTts(): void {
  clearIdleTimer()
  const proc = child
  if (!proc) return
  stopping = true
  child = null
  ready = false
  try {
    proc.postMessage({ cmd: "shutdown" })
  } catch {
    // already dead
  }
  const kill = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // already dead
    }
  }, GRACE_MS)
  kill.unref?.()
}
