/**
 * Parakeet TDT 0.6B v3 (NVIDIA) dictation engine via `sherpa-onnx-node`.
 *
 * Why this engine: it is the candidate that runs on Windows and Linux (where there is no
 * system recognizer in pt-BR) and `sherpa-onnx-node` is an N-API addon —
 * stable ABI, so the SAME package runs inside Electron without a rebuild. It runs
 * on the CPU on purpose (so much so that the Mac measurement serves as a reference for the
 * other platforms).
 *
 * Parakeet is NOT a streaming model. The "live" mode is assembled like this (it is the
 * design measured in the lab, `Testes/vozlab/lib/parakeet-stt.js`):
 *   - the Silero VAD closes a segment at every pause; each closed segment is
 *     transcribed ONCE and becomes confirmed text;
 *   - the still-open segment is re-transcribed from time to time and shows up as
 *     provisional — Parakeet's cost grows with the audio, so re-transcribing
 *     only the current segment is cheap;
 *   - on stop, the VAD closes the last segment and only it is left to transcribe (it is what
 *     push-to-talk waits for).
 *
 * Three precautions that only showed up while measuring in the lab (and are here):
 *   1. the VAD segment starts AFTER the real beginning of the speech, so it is
 *      transcribed from our buffer with 0.4 s of preroll before and 0.25 s
 *      after — without that the first word disappears ("Send message" → "message");
 *   2. the provisional one has a brake (interval ≥ 2× the duration of the last inference),
 *      otherwise the CPU stays 100% busy re-transcribing a segment that grows;
 *   3. the recognizer context is NOT reentrant: every decoding of the
 *      same model goes through a single queue.
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  ensureParakeetExtracted,
  isParakeetReady,
  parakeetArchiveComplete,
  parakeetFilesDir,
  PARAKEET_ID,
  sileroVadPath,
  modelsDir,
} from './models-store'
import { collectGarbageSoon } from '../gc'
import { PARAKEET_FILES, SILERO_VAD_URL } from './catalog'
import { SampleBuffer, samplesToMs, STT_SAMPLE_RATE } from './audio'
import type { SttEngine, SttEngineStatus, SttHandle, SttStartInput, SttSegment, SttWord } from './engine'

// ---------------------------------------------------------------------------
// Native module loading (optional: the app works without it, without the engine)
// ---------------------------------------------------------------------------

interface SherpaStream {
  acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  decodeAsync(stream: SherpaStream): Promise<SherpaResult>
}
/** Transducer result: BPE tokens with the start (s) and, in TDT, the duration (s). */
interface SherpaResult {
  text?: string
  tokens?: string[]
  timestamps?: number[]
  durations?: number[]
}
interface SherpaOfflineRecognizer {
  createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer>
}
interface SherpaSpeechSegment {
  start: number
  samples: Float32Array
}
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  isDetected(): boolean
  front(enableExternalBuffer?: boolean): SherpaSpeechSegment
  pop(): void
  flush(): void
}
interface SherpaModule {
  OfflineRecognizer: SherpaOfflineRecognizer
  Vad: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVad
}

const _require = createRequire(import.meta.url)
let sherpa: SherpaModule | null = null
let loadError: string | null = null
try {
  sherpa = _require('sherpa-onnx-node') as SherpaModule
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
}

const RATE = STT_SAMPLE_RATE
const ENGINE_ID = 'parakeet'
const ENGINE_LABEL = 'Parakeet (sherpa-onnx, CPU)'
const DEFAULT_MODEL_ID = PARAKEET_ID
const THREADS = [2, 4, 8]
const DEFAULT_THREADS = 4

const VAD_WINDOW = 512 // Silero wants windows of exactly 512 samples at 16 kHz
const TAIL_EVERY_SAMPLES = RATE / 2 // re-transcribes the open segment every ~0.5 s...
const TAIL_DUTY = 2 // ...or every 2× the time of the last re-transcription, whichever is greater
const TAIL_MAX_SAMPLES = RATE * 20
// Padding of the confirmed segment (the VAD delays the speech start by ~0.25 s).
const SEG_PREROLL = Math.round(RATE * 0.4)
const SEG_POSTROLL = Math.round(RATE * 0.25)
const STOP_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// Recognizer: one loaded per thread count, warmed up, with a single queue
// ---------------------------------------------------------------------------

interface RecognizerEntry {
  threads: number
  promise: Promise<SherpaRecognizer>
  loadMs: number | null
  error: string | null
}

let recognizerEntry: RecognizerEntry | null = null

/** Single recognizer queue: the context is not reentrant (measured in the lab). */
let decodeChain: Promise<unknown> = Promise.resolve()
function withRecognizer<T>(fn: () => Promise<T>): Promise<T> {
  const run = decodeChain.then(fn, fn)
  decodeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function recognizerConfig(threads: number): Record<string, unknown> {
  const dir = parakeetFilesDir()
  return {
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, 'encoder.int8.onnx'),
        decoder: path.join(dir, 'decoder.int8.onnx'),
        joiner: path.join(dir, 'joiner.int8.onnx'),
      },
      tokens: path.join(dir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  }
}

function warmRecognizer(threads: number): Promise<SherpaRecognizer> {
  const mod = sherpa
  if (!mod) throw new Error(`sherpa-onnx-node is not available: ${loadError}`)
  if (recognizerEntry && recognizerEntry.threads === threads && !recognizerEntry.error) {
    return recognizerEntry.promise
  }
  const t0 = Date.now()
  let loadMs: number | null = null
  const promise = (async () => {
    const rec = await mod.OfflineRecognizer.createAsync(recognizerConfig(threads))
    // The 1st inference initialises the ONNX Runtime: paid here, not in the user's speech.
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) })
    await rec.decodeAsync(stream)
    loadMs = Date.now() - t0
    return rec
  })()
  const entry: RecognizerEntry = { threads, promise, loadMs: null, error: null }
  promise.then(
    () => {
      entry.loadMs = loadMs
    },
    (err: unknown) => {
      entry.error = err instanceof Error ? err.message : String(err)
    },
  )
  recognizerEntry = entry
  return promise
}

/**
 * Warms the recognizer WITHOUT opening a session: extracts the package (if needed) and loads
 * the model, including the first inference that initialises the ONNX Runtime.
 *
 * It is what takes the loading off the user's path — without it, holding the
 * microphone for the first time waits for hundreds of MB to be read, with the
 * button red. Idempotent (`warmRecognizer` returns the promise already in flight)
 * and silent: a load error does not become an exception, it is recorded and shows up in
 * `status()`.
 */
export async function warm(modelId?: string | null, threads = DEFAULT_THREADS): Promise<void> {
  if (modelId && modelId !== DEFAULT_MODEL_ID) return
  try {
    await ensureParakeetExtracted()
    await warmRecognizer(THREADS.includes(threads) ? threads : DEFAULT_THREADS)
  } catch {
    // no engine or load failed: the reason is already in `status()`
  }
}

/**
 * Releases the loaded recognizer (the facade calls it when dictation goes idle).
 * The next `warm`/`start` loads it again — it is what keeps the hundreds-of-MB
 * model from staying resident for the whole session.
 */
export function release(): void {
  if (!recognizerEntry) return
  recognizerEntry = null
  // Dropping the reference is not enough: the ~700 MB are native and only come back when the
  // GC collects the wrapper — which, with no pressure on the JS heap, never happens.
  collectGarbageSoon()
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface ParakeetSession {
  id: string
  threads: number
  live: boolean
  /** Build the timing of each word (transcription for video editing). */
  words: boolean
  onPartial: (text: string) => void
  vad: SherpaVad
  buffer: SampleBuffer
  leftover: Float32Array
  commitPos: number
  gen: number
  confirmed: string[]
  provisional: string
  lastView: [string, string]
  chain: Promise<unknown>
  tailQueued: boolean
  lastTailAt: number
  lastTailMs: number
  stopping: boolean
  cancelled: boolean
  segments: number
  /** Confirmed segments with their position in the audio — the transcription timings. */
  timed: SttSegment[]
}

/** Queues work in the session: never in parallel, never out of order. */
function enqueue(s: ParakeetSession, fn: () => Promise<void>): Promise<void> {
  const run = s.chain.then(fn, fn)
  s.chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function decodeFull(s: ParakeetSession, samples: Float32Array): Promise<SherpaResult> {
  const rec = await warmRecognizer(s.threads)
  return withRecognizer(async () => {
    const stream = rec.createStream()
    stream.acceptWaveform({ sampleRate: RATE, samples })
    return rec.decodeAsync(stream)
  })
}

async function decode(s: ParakeetSession, samples: Float32Array): Promise<string> {
  return String((await decodeFull(s, samples)).text || '').trim()
}

/**
 * Words from the transducer tokens. The token that opens a word comes with a
 * leading space (" H", "ello" → "Hello"); punctuation sticks to the previous one. The end
 * is the start of the last token + its duration (TDT); without a duration, the start of the
 * next token. `offsetMs` is where the decoded segment starts in the audio.
 */
export function tokensToWords(r: SherpaResult, offsetMs: number): SttWord[] {
  const tokens = r.tokens ?? []
  const starts = r.timestamps ?? []
  const durations = r.durations ?? []
  const words: SttWord[] = []
  let current: { text: string; start: number; end: number } | null = null
  const close = () => {
    const text = current?.text.trim()
    if (current && text) {
      words.push({ startMs: Math.round(offsetMs + current.start * 1000), endMs: Math.round(offsetMs + current.end * 1000), text })
    }
    current = null
  }
  tokens.forEach((token, i) => {
    const start = starts[i] ?? 0
    const end = start + (durations[i] || (starts[i + 1] !== undefined ? starts[i + 1] - start : 0.08))
    const opens = /^[\s▁]/.test(token) || !current
    const punctuation = /^[.,!?;:…]+$/.test(token.trim())
    if (opens && !punctuation) {
      close()
      current = { text: token.replace(/^[\s▁]+/, ''), start, end }
      // Pure space token (" "): the word starts at the next one.
      if (!current.text) current = null
      return
    }
    if (!current) current = { text: '', start, end }
    current.text += token.replace(/▁/g, '')
    current.end = Math.max(current.end, end)
  })
  close()
  return words
}

/** Publishes the live text: confirmed + provisional, only when it changes. */
function publish(s: ParakeetSession): void {
  // Without a live preview, the caller wants no callback at all — not even at the end.
  if (!s.live) return
  const confirmed = s.confirmed.filter(Boolean).join(' ')
  const provisional = s.provisional
  if (confirmed === s.lastView[0] && provisional === s.lastView[1]) return
  s.lastView = [confirmed, provisional]
  const text = [confirmed, provisional].filter(Boolean).join(' ').trim()
  try {
    s.onPartial(text)
  } catch {
    // the callback belongs to the caller; an error in it cannot take the session down
  }
}

/** Segment closed by the VAD: transcribes once (with the padding) and confirms it. */
function commitSegment(s: ParakeetSession, seg: SherpaSpeechSegment): void {
  const from = Math.max(s.commitPos, seg.start - SEG_PREROLL)
  const end = Math.min(s.buffer.samples, seg.start + seg.samples.length + SEG_POSTROLL)
  s.commitPos = Math.max(s.commitPos, end)
  s.gen += 1 // invalidates in-flight re-transcriptions of the open segment
  s.segments += 1
  const samples = s.buffer.slice(from, end)
  void enqueue(s, async () => {
    const result = await decodeFull(s, samples)
    const text = String(result.text || '').trim()
    if (s.cancelled) return
    if (text) {
      const words = s.words ? tokensToWords(result, samplesToMs(from)) : undefined
      s.timed.push({ startMs: samplesToMs(from), endMs: samplesToMs(end), text, ...(words ? { words } : {}) })
    }
    s.confirmed.push(text)
    s.provisional = ''
    publish(s)
  })
}

/** Re-transcribes the open segment (provisional); at most one in the queue at a time. */
function scheduleTail(s: ParakeetSession): void {
  if (!s.live || s.tailQueued || s.stopping || s.cancelled) return
  // Brake: the open segment grows and each re-transcription gets more expensive. Without this
  // the 21 s clip cost 9.3 s of CPU in the lab (44 decodings).
  const every = Math.max(TAIL_EVERY_SAMPLES, Math.round(s.lastTailMs * TAIL_DUTY * (RATE / 1000)))
  if (s.buffer.samples - s.lastTailAt < every) return
  if (!s.vad.isDetected()) {
    if (s.provisional) {
      s.provisional = ''
      publish(s)
    }
    return
  }
  s.tailQueued = true
  s.lastTailAt = s.buffer.samples
  const gen = s.gen
  void enqueue(s, async () => {
    s.tailQueued = false
    if (s.stopping || s.cancelled || gen !== s.gen) return
    const from = Math.max(s.commitPos, s.buffer.samples - TAIL_MAX_SAMPLES)
    const t0 = Date.now()
    const text = await decode(s, s.buffer.slice(from, s.buffer.samples))
    s.lastTailMs = Date.now() - t0
    if (s.stopping || s.cancelled || gen !== s.gen) return
    s.provisional = text
    publish(s)
  })
}

function drainVad(s: ParakeetSession): void {
  while (!s.vad.isEmpty()) {
    const seg = s.vad.front(false) // copy: the internal buffer is reused on pop
    s.vad.pop()
    commitSegment(s, seg)
  }
}

function feedVad(s: ParakeetSession, chunk: Float32Array): void {
  const all = new Float32Array(s.leftover.length + chunk.length)
  all.set(s.leftover)
  all.set(chunk, s.leftover.length)
  let off = 0
  for (; off + VAD_WINDOW <= all.length; off += VAD_WINDOW) {
    s.vad.acceptWaveform(all.subarray(off, off + VAD_WINDOW))
  }
  s.leftover = all.slice(off)
}

/**
 * Engine state.
 *
 * `available` = a session can be opened now: the module loaded and the model
 * package is on disk (the extraction and the VAD, which the engine resolves on first
 * use, do not take away from `available` — only from `installed`).
 * `installed` = already extracted and with the VAD: nothing to prepare before speaking.
 */
async function status(): Promise<SttEngineStatus> {
  const archive = parakeetArchiveComplete()
  const ready = isParakeetReady()
  const models = {
    defaultModelId: DEFAULT_MODEL_ID,
    archive,
    ready,
    dir: modelsDir(),
    files: PARAKEET_FILES,
    vad: sileroVadPath(),
    vadUrl: SILERO_VAD_URL,
  }
  if (!sherpa) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: ready,
      reason: `the sherpa-onnx-node module did not load: ${loadError}`,
      detail: models,
    }
  }
  if (!archive && !ready) {
    return {
      engine: ENGINE_ID,
      available: false,
      installed: false,
      reason: `the Parakeet package has not been downloaded yet (~487 MB at <userData>/voice/models/${DEFAULT_MODEL_ID})`,
      detail: { ...models, threads: THREADS, defaultThreads: DEFAULT_THREADS },
    }
  }
  return {
    engine: ENGINE_ID,
    available: true,
    installed: ready,
    // "Downloaded" is not "ready": the package needs to be extracted and the Silero VAD
    // downloaded. This now starts on its own at the end of the download (see status.ts), and the
    // fine-grained state of each model (with the reason) is `voice:status`.
    reason: ready
      ? undefined
      : 'the package is downloaded; extraction (and the Silero VAD) has not finished',
    detail: {
      ...models,
      threads: THREADS,
      defaultThreads: DEFAULT_THREADS,
      loaded: recognizerEntry
        ? { threads: recognizerEntry.threads, loadMs: recognizerEntry.loadMs, error: recognizerEntry.error }
        : null,
    },
  }
}

async function start(input: SttStartInput, onPartial: (text: string) => void): Promise<SttHandle> {
  const st = await status()
  if (!st.available) throw new Error(st.reason || 'the Parakeet engine is not available')
  const mod = sherpa
  if (!mod) throw new Error(`sherpa-onnx-node is not available: ${loadError}`)

  const modelId = input.modelId || DEFAULT_MODEL_ID
  if (modelId !== DEFAULT_MODEL_ID) {
    throw new Error(`the Parakeet engine only has the model "${DEFAULT_MODEL_ID}" (got "${modelId}")`)
  }
  const threads = input.threads ?? DEFAULT_THREADS
  if (!THREADS.includes(threads)) {
    throw new Error(`invalid threads for the Parakeet: ${threads} (use ${THREADS.join(', ')})`)
  }

  // Extracts the package (if needed) and WARMS UP before opening the session: any preparation
  // error comes out at start, not in the middle of the user's speech.
  await ensureParakeetExtracted()
  await warmRecognizer(threads)

  const s: ParakeetSession = {
    id: randomUUID(),
    threads,
    live: input.live,
    words: input.timestamps === 'words',
    onPartial,
    vad: new mod.Vad(
      {
        sileroVad: {
          model: sileroVadPath(),
          threshold: 0.5,
          minSilenceDuration: 0.5,
          minSpeechDuration: 0.25,
          windowSize: VAD_WINDOW,
          maxSpeechDuration: 15,
        },
        sampleRate: RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: false,
      },
      60,
    ),
    buffer: new SampleBuffer(),
    leftover: new Float32Array(0),
    commitPos: 0,
    gen: 0,
    confirmed: [],
    provisional: '',
    lastView: ['', ''],
    chain: Promise.resolve(),
    tailQueued: false,
    lastTailAt: 0,
    lastTailMs: 0,
    stopping: false,
    cancelled: false,
    segments: 0,
    timed: [],
  }

  return {
    pushAudio(samples: Float32Array): void {
      if (s.stopping || s.cancelled) return
      s.buffer.push(samples)
      feedVad(s, samples)
      drainVad(s)
      scheduleTail(s)
    },

    async stop(): Promise<{ text: string; audioMs: number; segments: SttSegment[] }> {
      s.stopping = true
      s.gen += 1 // discards the in-flight provisional
      // Closes the rest of the buffer in the VAD so the last segment becomes confirmed.
      if (s.leftover.length) {
        const pad = new Float32Array(VAD_WINDOW)
        pad.set(s.leftover)
        s.vad.acceptWaveform(pad)
        s.leftover = new Float32Array(0)
      }
      s.vad.flush()
      drainVad(s)
      // The VAD saw no speech at all (whisper, very short speech): transcribe everything.
      if (s.segments === 0 && s.buffer.samples >= RATE * 0.3) {
        const all = s.buffer.slice(0, s.buffer.samples)
        void enqueue(s, async () => {
          const result = await decodeFull(s, all)
          const text = String(result.text || '').trim()
          if (text) {
            const words = s.words ? tokensToWords(result, 0) : undefined
            s.timed.push({ startMs: 0, endMs: samplesToMs(all.length), text, ...(words ? { words } : {}) })
          }
          s.confirmed.push(text)
        })
      }

      const timedOut = await Promise.race([
        s.chain.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), STOP_TIMEOUT_MS)),
      ])
      s.provisional = ''
      s.lastView = ['', '']
      publish(s)
      if (timedOut) throw new Error(`the transcription did not finish in ${STOP_TIMEOUT_MS / 1000} s`)
      return { text: s.confirmed.filter(Boolean).join(' '), audioMs: samplesToMs(s.buffer.samples), segments: s.timed }
    },

    async cancel(): Promise<void> {
      s.cancelled = true
      s.stopping = true
      s.gen += 1
      s.confirmed = []
      s.provisional = ''
    },
  }
}

export const parakeetEngine: SttEngine = {
  id: ENGINE_ID,
  label: ENGINE_LABEL,
  defaultModelId: DEFAULT_MODEL_ID,
  status,
  start,
}
