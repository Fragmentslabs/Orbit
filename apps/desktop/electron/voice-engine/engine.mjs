/**
 * Orbit TTS engine: child process of the main (utilityProcess) that runs
 * Supertonic 3 (ONNX Runtime, CPU) and returns the audio IN PIECES.
 *
 * Why a separate process: inference is CPU-bound and holds the Node thread for
 * seconds — in the main that would freeze windows and IPC. Here it lives
 * in a process that can be killed (for idleness) and whose memory peak
 * (~1 GB) is not the app's.
 *
 * Protocol with the main (lib/voice/tts.ts): messages through `process.parentPort`
 * — the Electron `utilityProcess.fork` does NOT accept stdin as a pipe, so the
 * channel is the MessagePort, with the same message format as the lab:
 *
 *   input:  { id, cmd: "speak", text, voice?, lang?, speed?, steps?, maxChars? }
 *             { cmd: "status" } | { cmd: "cancel", id } | { cmd: "shutdown" }
 *   output:   { type: "ready", sr, nativeSr, voices, languages, bootMs }
 *             { type: "status", ... } | { type: "error", message }
 *             { id, start: true, pieces, sr, voice, lang }
 *             { id, i, n, text, sr, audioMs, synthMs, firstMs, pcm: <base64 PCM16> }
 *             { id, done: true, pieces, synthMs, audioMs, wallMs, rtf }
 *             { id, done: true, error: "..." }        (failed midway)
 *
 * Usage: utilityProcess.fork("engine.mjs", ["--assets", "<folder with onnx/ voice_styles/>"])
 */

import fs from "fs"
import path from "path"
import { loadTextToSpeech, loadVoiceStyle } from "./helper.js"
import { splitForStreaming } from "./split.mjs"

// ------------------------------------------------------------------ arguments
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const ASSETS_DIR = arg("assets", process.env.ORBIT_VOICE_ASSETS || "")
const ONNX_DIR = path.join(ASSETS_DIR, "onnx")
const STYLES_DIR = path.join(ASSETS_DIR, "voice_styles")

const NATIVE_SAMPLE_RATE = 44100 // native rate of the Supertonic 3 models
const SAMPLE_RATE = Number(arg("sample-rate", 24000)) // rate of the PCM delivered
const STEPS = Number(arg("steps", 8)) // 8 = upstream default
const MAX_CHARS = Number(arg("max-chars", 140)) // target per piece in the streaming
const DEFAULT_VOICE = "F2" // default voice of Orbit (bright female)
const DEFAULT_LANG = "pt"
const DEFAULT_SPEED = 1
const VOICE_IDS = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]
const LANGUAGES = [
  "ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hi", "hr",
  "hu", "id", "it", "ja", "ko", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk",
  "sl", "sv", "tr", "uk", "vi", "na",
]

// Log goes to stderr: stdout is reserved for the protocol, but even
// so the main ignores loose lines (the native ONNX library writes straight
// to the descriptor and it cannot be intercepted).
const log = (...parts) => {
  try {
    process.stderr.write(parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ") + "\n")
  } catch {
    // stderr closed (main shutting down): nothing to do
  }
}
console.log = log
console.info = log
console.warn = log

const parentPort = process.parentPort
const send = (msg) => {
  try {
    parentPort.postMessage(msg)
  } catch (err) {
    log("[engine] failed to send message:", err?.message ?? err)
  }
}

// ------------------------------------------------------------------ resampler
/**
 * Band-limited resampling (Blackman window + sinc, polyphase table).
 * 44100 -> 24000 is a rational factor 147/80, resolved by direct interpolation
 * with a 65-tap kernel and per-phase DC gain normalization.
 */
const PHASES = 1024
let resampleTable = null
let resampleK = 0

function buildResampleTable(fsIn, fsOut) {
  const ratio = fsIn / fsOut
  const K = Math.ceil(16 * ratio) + 1
  const cutoff = (Math.min(fsIn, fsOut) / 2) * 0.94 // light anti-alias guard
  const fc = cutoff / fsIn
  const table = new Float64Array(PHASES * (2 * K + 1))

  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES
    let sum = 0
    for (let k = 0; k <= 2 * K; k++) {
      const d = frac + K - k
      const x = 2 * fc * d
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = d <= -K || d >= K ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * d) / K) + 0.08 * Math.cos((2 * Math.PI * d) / K)
      const v = 2 * fc * sinc * w
      table[p * (2 * K + 1) + k] = v
      sum += v
    }
    if (sum !== 0) {
      for (let k = 0; k <= 2 * K; k++) table[p * (2 * K + 1) + k] /= sum // DC gain = 1
    }
  }
  resampleK = K
  resampleTable = table
}

function resample(input, fsIn, fsOut) {
  if (fsIn === fsOut) return input
  if (!resampleTable) buildResampleTable(fsIn, fsOut)
  const K = resampleK
  const taps = 2 * K + 1
  const ratio = fsIn / fsOut
  const nOut = Math.floor((input.length / fsIn) * fsOut)
  const out = new Float32Array(nOut)

  for (let m = 0; m < nOut; m++) {
    const t = m * ratio
    const i0 = Math.floor(t)
    let p = Math.round((t - i0) * PHASES)
    let base = i0
    if (p >= PHASES) {
      p = 0
      base = i0 + 1
    }
    const row = p * taps
    let acc = 0
    for (let k = 0; k < taps; k++) {
      const j = base - K + k
      if (j >= 0 && j < input.length) acc += input[j] * resampleTable[row + k]
    }
    out[m] = acc
  }
  return out
}

/** Float32 -> raw PCM 16-bit LE (the stream carries samples, not a WAV per piece). */
function floatToPcm16(samples) {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.floor(s * 32767), i * 2)
  }
  return buf
}

// -------------------------------------------------------------- engine state
let tts = null // ONNX models loaded (warm)
const styles = new Map() // voice id -> Style
let bootMs = 0
let busy = false

/** Serializes the inference: the Runtime is CPU-bound and Node is single-threaded. */
let chain = Promise.resolve()
function withLock(fn) {
  const next = chain.then(fn, fn)
  chain = next.then(
    () => {},
    () => {},
  )
  return next
}

/** Ids cancelled by the main (the `cancel` may arrive before or during the piece). */
const cancelledIds = new Set()

async function boot() {
  const t0 = Date.now()
  if (!ASSETS_DIR) throw new Error("--assets not given (folder with the models)")
  if (!fs.existsSync(ONNX_DIR)) throw new Error(`ONNX models missing in ${ONNX_DIR} — download them in Settings → Voice`)
  log(`[boot] loading ONNX models from ${ONNX_DIR} ...`)
  tts = await loadTextToSpeech(ONNX_DIR, false)
  log(`[boot] models ready (native rate ${tts.sampleRate} Hz); loading voices...`)
  for (const id of VOICE_IDS) {
    const file = path.join(STYLES_DIR, `${id}.json`)
    if (!fs.existsSync(file)) continue
    styles.set(id, loadVoiceStyle([file], false))
  }
  if (styles.size === 0) throw new Error(`no voice found in ${STYLES_DIR}`)
  if (SAMPLE_RATE !== tts.sampleRate) {
    buildResampleTable(tts.sampleRate, SAMPLE_RATE)
    log(`[boot] resampling ${tts.sampleRate} Hz -> ${SAMPLE_RATE} Hz`)
  }
  bootMs = Date.now() - t0
  log(`[boot] ok in ${bootMs} ms — voices: ${[...styles.keys()].join(", ")}`)
}

function normalizeVoice(v) {
  if (v == null || v === "") return DEFAULT_VOICE
  const id = String(v).toUpperCase().replace(/\.JSON$/, "").trim()
  return styles.has(id) ? id : null
}

/** Silence linking the pieces, the same as in the `call()` of the engine (0.3 s). */
const silence = () => new Float32Array(Math.floor(0.3 * SAMPLE_RATE))

async function speak(msg) {
  const id = String(msg.id ?? "")
  const text = typeof msg.text === "string" ? msg.text.trim() : ""
  if (!id) return
  if (!text) return send({ id, done: true, error: "empty text" })
  if (!tts) return send({ id, done: true, error: "the engine is not ready" })

  const voice = normalizeVoice(msg.voice)
  if (voice === null) return send({ id, done: true, error: `unknown voice: ${msg.voice}` })
  const lang = String(msg.lang ?? DEFAULT_LANG).toLowerCase()
  if (!LANGUAGES.includes(lang)) return send({ id, done: true, error: `unsupported language: ${msg.lang}` })
  const speed = Math.min(2, Math.max(0.5, Number(msg.speed) || DEFAULT_SPEED))
  const steps = Number.isInteger(msg.steps) ? Math.min(32, Math.max(1, msg.steps)) : STEPS
  const maxChars = Number.isInteger(msg.maxChars) ? msg.maxChars : MAX_CHARS

  const style = styles.get(voice)
  const pieces = splitForStreaming(text, maxChars)
  if (!pieces.length) return send({ id, done: true, error: "nothing to synthesize after cleaning the text" })

  const streamStart = Date.now()
  let totalSynthMs = 0
  let totalSamples = 0

  send({ id, start: true, pieces: pieces.length, sr: SAMPLE_RATE, nativeSr: tts.sampleRate, voice, lang, chars: pieces.map((p) => p.length) })

  try {
    for (let i = 0; i < pieces.length; i++) {
      if (cancelledIds.has(id)) break
      const piece = pieces[i]
      const t0 = Date.now()
      let tInfer = t0
      const out = await withLock(() => {
        if (cancelledIds.has(id)) return null // gave up while waiting for its turn
        tInfer = Date.now()
        busy = true
        return tts._infer([piece], [lang], style, steps, speed)
      })
      if (!out) break
      // They cancelled while this piece was being inferred: do not deliver its audio
      // (the main has already stopped waiting, and a piece after the cancel is garbage).
      if (cancelledIds.has(id)) break
      const synthMs = Date.now() - tInfer
      totalSynthMs += synthMs

      let pcm = resample(Float32Array.from(out.wav), tts.sampleRate, SAMPLE_RATE)
      if (i < pieces.length - 1) {
        const sil = silence()
        const merged = new Float32Array(pcm.length + sil.length)
        merged.set(pcm, 0)
        merged.set(sil, pcm.length)
        pcm = merged
      }
      totalSamples += pcm.length

      send({
        id,
        i,
        n: pieces.length,
        text: piece,
        sr: SAMPLE_RATE,
        audioMs: Math.round((pcm.length / SAMPLE_RATE) * 1000),
        synthMs,
        queueMs: tInfer - t0, // waiting for its turn, it is not inference
        // Time from the request until THIS piece is ready: on the first one, it is the
        // latency the streaming exists to reduce.
        firstMs: Date.now() - streamStart,
        pcm: floatToPcm16(pcm).toString("base64"),
      })
    }
    busy = false
  } catch (err) {
    busy = false
    cancelledIds.delete(id)
    return send({ id, done: true, error: String(err?.message ?? err) })
  }

  const cancelled = cancelledIds.has(id)
  cancelledIds.delete(id)
  const audioMs = Math.round((totalSamples / SAMPLE_RATE) * 1000)
  const wallMs = Date.now() - streamStart
  send({
    id,
    done: true,
    cancelled: cancelled || undefined,
    pieces: pieces.length,
    synthMs: totalSynthMs,
    audioMs,
    wallMs,
    rtf: audioMs ? Number((wallMs / audioMs).toFixed(3)) : null,
  })
}

function status() {
  return {
    type: "status",
    ready: tts !== null,
    busy,
    voices: [...styles.keys()],
    languages: LANGUAGES,
    sr: SAMPLE_RATE,
    nativeSr: tts?.sampleRate ?? NATIVE_SAMPLE_RATE,
    bootMs,
    modelVersion: tts?.cfgs?.tts_version ?? null,
  }
}

parentPort.on("message", (event) => {
  const msg = event?.data
  if (!msg || typeof msg !== "object") return
  switch (msg.cmd) {
    case "speak":
      void speak(msg)
      return
    case "cancel":
      cancelledIds.add(String(msg.id))
      return
    case "status":
      send(status())
      return
    case "shutdown":
      log("[engine] shutting down at the request of the main")
      process.exit(0)
      return
    default:
      send({ type: "error", message: `unknown command: ${String(msg.cmd)}` })
  }
})
parentPort.start()

// ------------------------------------------------------------------------ main
try {
  await boot()
  // the `type` comes AFTER the spread: status() also has a `type`, and the one of the status
  // would overwrite the one of the ready (the main would silently ignore the message).
  send({ ...status(), type: "ready" })
} catch (err) {
  log("[engine][error] boot failed:", err?.stack ?? err)
  send({ type: "error", fatal: true, message: String(err?.message ?? err) })
  process.exit(1)
}
