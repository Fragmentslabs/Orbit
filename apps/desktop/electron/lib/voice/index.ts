import { BrowserWindow, ipcMain } from "electron"
import { randomUUID } from "node:crypto"
import type {
  VoiceDownloadProgress,
  VoiceEngineId,
  VoiceHardwareInfo,
  VoiceModelInfo,
  VoiceTtsEngine,
} from "@shared/voice"
import type { VoiceStatusResponse } from "@shared/companion"
import type { AppSettings } from "@shared/app-settings"
import { getAppSettings, onAppSettingsChange } from "../app-settings"
import { VOICE_MODELS, TTS_MODEL_ID, modelInfo } from "./manifest"
import { cancelDownload, isModelDownloaded, removeModel, startDownload } from "./download"
import { onParakeetExtractPhaseChange } from "./models-store"
import { speakWithModel } from "./model-tts"
import { downloadedModelIds, voiceStatusSnapshot } from "./status"
import { detectHardware } from "./hardware"
import { shutdownTts, speak, ttsStatus } from "./tts"
import { shutdownWhisperServers } from "./whisper"
import { pickSpeechLang } from "./lang-detect"
import { currentMainLocale } from "../i18n"
import type { SttSegment } from "./engine"
import {
  STT_SAMPLE_RATE,
  concatFloat32,
  encodeWavPcm16,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleLinear,
  samplesToMs,
  splitForSynthesis,
  splitPcmWindows,
} from "./audio"
// STT is the other worker: here we only consume what it exports (see the footer).
import {
  STT_MODELS,
  cancelSttSession,
  prepareSttModel,
  pushSttAudio,
  releaseSttModels,
  startSttSession,
  sttEngineStatus,
  stopSttSession,
  sttPreloadEnabled,
  warmSttModel,
} from "./stt"

/**
 * Facade of the voice core: `registerVoiceIpc()` wires the channels and the rest of the
 * file is what other main modules use through a direct import.
 *
 * Channel contract (consumed by three renderer screens — DO NOT rename):
 *   invoke "voice:hardware"          -> VoiceHardwareInfo
 *   invoke "voice:models"            -> VoiceModelInfo[]
 *   invoke "voice:status"            -> VoiceStatusSnapshot
 *   invoke "voice:download"          { modelId }  -> { started: boolean }
 *   invoke "voice:download-cancel"   { modelId }  -> void
 *   invoke "voice:remove-model"      { modelId }  -> void
 *   event  "voice:download-progress" -> VoiceDownloadProgress
 *   event  "voice:status-changed"    -> VoiceStatusSnapshot (on every change)
 *   invoke "voice:tts:start"         { text, voice?, lang?, speed?, engine? } -> { id }
 *                                     (`engine`: audio priority "model" | "local";
 *                                      without it, the settings one applies)
 *   event  "voice:tts:chunk"         -> { id, pcm (base64 PCM16), sr, i, n, seg? }
 *                                     (`seg`: sentence number, only in continuous speech)
 *   event  "voice:tts:done"          -> { id, error? }
 *   invoke "voice:tts:cancel"        { id } -> void
 *   invoke "voice:tts:stream-start"  { voice?, lang?, speed?, engine? } -> { id }
 *   invoke "voice:tts:stream-append" { id, text }   (new sentence, in order)
 *   invoke "voice:tts:stream-clear"  { id }         (discards the sentences not yet generated)
 *   invoke "voice:tts:stream-end"    { id }         (no more sentences arrive)
 *                                     continuous speech: chunk/done/cancel as above
 *
 * The STT models live in the catalog (`voice:models`) and in `voice:status`
 * (available engines); the dictation sessions themselves belong to the STT worker, which
 * registers its channels in ./stt.
 */

/** Voice events go to ALL windows (the app may have more than one). */
function emit(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

async function hardware(): Promise<VoiceHardwareInfo> {
  return detectHardware({ downloadedIds: await downloadedModelIds() })
}

/**
 * Publishes the current snapshot on `voice:status-changed`. The renderer listens to that
 * channel to revalidate the speech button and the badges — without this, downloading the model
 * and going back to the chat left the button disabled (nothing announced the change).
 */
async function emitStatusChanged(): Promise<void> {
  emit("voice:status-changed", await voiceStatusSnapshot())
}

/**
 * After the end of a download: announces the new state and, when the model is a
 * PACKAGE (Parakeet's `.tar.bz2`), extracts it right away — "downloaded" never ends up
 * presenting itself as "ready". The extraction may also start on first use
 * (inside the engine); both paths go through the same phase notice (see
 * `onParakeetExtractPhaseChange` in ./models-store).
 */
async function afterDownload(modelId: string, progress: VoiceDownloadProgress): Promise<void> {
  await emitStatusChanged()
  if (!progress.done || progress.error) return
  const model = modelInfo(modelId)
  if (!model) return
  // Cancellation arrives as `done` without an error: it only prepares what is complete.
  if (!(await isModelDownloaded(modelId))) return
  if (model.archive) {
    await prepareSttModel(modelId).catch(() => {
      // the failure is already recorded in the extraction phase (it shows up in the next status)
    })
    await emitStatusChanged()
  }
  // Warms up in the background, without `await`: the first dictation should not pay for
  // the model loading (in Parakeet, hundreds of MB in the ONNX Runtime). It does
  // nothing when the id is not a dictation one — see `warmSttModel`.
  void warmSttModel(modelId)
}

/** Utterances in progress, by id — that is how `voice:tts:cancel` finds the request. */
const speechJobs = new Map<string, AbortController>()

/** Continuous speech: sentences waiting for synthesis, in the order they arrived. */
interface SpeechStream {
  request: SpeechRequest
  /** `seg` is assigned on the sentence's ARRIVAL (the append order), not on generation: the
   *  ones discarded by a clear also consume a number, and the renderer — which counts
   *  the ones it sent — stays aligned with the main. */
  queue: { text: string; seg: number }[]
  /** Number of the next sentence to arrive (it goes in the chunks as `seg`). */
  next: number
  /** No more sentences arrive: with the queue empty, the speech ends. */
  closed: boolean
  running: boolean
  signal: AbortSignal
  /** Language already decided in this utterance (in "Automatic" mode): an ambiguous sentence
   *  ("Claro.") inherits the previous one's instead of changing the accent. */
  language: { lang?: string }
}

const streams = new Map<string, SpeechStream>()

/**
 * Synthesises the queue of a continuous utterance, one sentence at a time, without waiting for the
 * renderer to play anything — generation runs ahead of playback. It ends (with
 * `done`) when the utterance was closed and the queue emptied, or on the first error.
 */
async function drainStream(id: string): Promise<void> {
  const stream = streams.get(id)
  if (!stream || stream.running) return
  stream.running = true
  try {
    while (stream.queue.length > 0 && !stream.signal.aborted) {
      const { text, seg } = stream.queue.shift() as { text: string; seg: number }
      await runSpeech(id, text, stream.request, stream.signal, seg, stream.language)
    }
  } catch (err) {
    streams.delete(id)
    speechJobs.delete(id)
    // Cancelled by the renderer (interrupt/turn off): nobody waits for anything anymore.
    if (!stream.signal.aborted) emit("voice:tts:done", { id, error: (err as Error).message ?? String(err) })
    return
  }
  stream.running = false
  if (stream.signal.aborted) {
    streams.delete(id)
    speechJobs.delete(id)
    return
  }
  // A sentence arrived while the last one was being generated: the loop above already took it; here
  // all that is left is to decide whether the utterance is over.
  if (stream.closed && stream.queue.length === 0) {
    streams.delete(id)
    speechJobs.delete(id)
    emit("voice:tts:done", { id })
  }
}

/** Speech request coming from the renderer (`voice:tts:start`). */
interface SpeechRequest {
  text?: string
  voice?: string
  lang?: string
  speed?: number
  /** Audio priority; without it, the settings one applies (`voice.tts.engine`). */
  engine?: VoiceTtsEngine
}

/** One chunk of the `voice:tts:chunk` contract (PCM16 base64). */
interface SpeechChunk {
  pcm: Buffer
  sr: number
  i: number
  n: number
  /** Text of the chunk, when the engine sends it (the local one does; the model one does not). */
  text?: string
}

/**
 * Runs ONE utterance through the engine chosen by the audio priority.
 *
 * `model` tries the provider route and, when it does not exist or fails BEFORE
 * delivering any chunk, falls back to the local engine — the preference does not leave the
 * reading mute. With audio already delivered, switching engines midway would splice two
 * different voices together, so the failure surfaces as an error.
 */
async function runSpeech(
  id: string,
  text: string,
  payload: SpeechRequest,
  signal: AbortSignal,
  /** Sentence number in continuous speech: the renderer shows the sentence that is playing. */
  seg?: number,
  language?: { lang?: string },
): Promise<void> {
  await synthesize(
    text,
    payload,
    signal,
    (chunk) =>
      // The chunk text goes along: the renderer reveals the caption of each
      // segment at the pace of the audio (the model route sends its own without text).
      emit("voice:tts:chunk", { id, pcm: chunk.pcm.toString("base64"), sr: chunk.sr, i: chunk.i, n: chunk.n, seg, text: chunk.text }),
    language,
  )
}

/**
 * Language when "Automatic" has no evidence (short, ambiguous text): the
 * fixed language, if there is one, otherwise the app interface's.
 */
function fallbackLanguage(): string {
  const fixed = getAppSettings().voice.tts.lang
  if (fixed && fixed !== "auto") return fixed
  return currentMainLocale() === "pt-BR" ? "pt" : "en"
}

/**
 * The synthesis itself, with no fixed destination: live speech sends the chunks to the
 * windows (`rodarFala`); the agent's audio file (`synthesizeToWav`) joins them
 * into a WAV.
 */
async function synthesize(
  text: string,
  payload: SpeechRequest,
  signal: AbortSignal,
  emitChunk: (chunk: SpeechChunk) => void,
  language?: { lang?: string },
): Promise<void> {
  // "auto" (the default) decides by the text: it is what will be spoken, and the local
  // engine speaks with the accent of the language it receives. A fixed language is forced.
  const lang = pickSpeechLang(payload?.lang ?? getAppSettings().voice.tts.lang, text, fallbackLanguage(), language)
  const request = { voice: payload?.voice, lang, speed: payload?.speed }
  const engine: VoiceTtsEngine = payload?.engine ?? getAppSettings().voice.tts.engine
  if (engine === "model") {
    let entregou = false
    try {
      await speakWithModel(
        text,
        request,
        (chunk) => {
          entregou = true
          emitChunk(chunk)
        },
        signal,
      )
      return
    } catch (err) {
      if (entregou || signal.aborted) throw err
      console.warn("[voice] model unavailable, falling back to the local engine:", err)
    }
  }
  // `local` — the Supertonic engine, offline.
  await speak(text, request, emitChunk, signal)
}

/**
 * Registers the voice channels. Called once, along with the other main
 * registrations (see main.ts) — nothing here may be registered twice.
 */
/**
 * Whisper chosen as the dictation engine: `whisper-server` comes up RIGHT AWAY, along with the
 * app, instead of on the first microphone press (the spawn + the ggml load
 * take seconds). Switching to another engine takes the server down at once.
 *
 * Called at boot (with what is on disk) and on every settings change.
 * It respects preloading: when off, the server comes up on the first dictation.
 * The server itself shuts down when idle (see whisper.ts).
 */
export function syncWhisperServer(next: AppSettings, prev?: AppSettings): void {
  const stt = next.voice.stt
  const before = prev?.voice.stt
  const wanted = stt.enabled && stt.preload && stt.engine === "whisper"
  if (before?.engine === "whisper" && stt.engine !== "whisper") shutdownWhisperServers()
  if (!wanted) return
  const changed =
    !before ||
    before.engine !== stt.engine ||
    before.modelId !== stt.modelId ||
    before.threads !== stt.threads ||
    !before.enabled ||
    !before.preload
  if (changed) void warmSttModel(stt.modelId, "whisper", stt.threads)
}

/**
 * Turning voice off gives the memory back RIGHT AWAY, instead of waiting for the five-minute
 * idle cycle: dictation turned off (or switched to another engine, or without preload) releases
 * the loaded model; reading turned off shuts the speech engine process down.
 * It runs before `syncWhisperServer`, which may bring up the new engine's server.
 */
export function releaseDisabledVoice(next: AppSettings, prev?: AppSettings): void {
  if (!prev) return
  const stt = next.voice.stt
  const before = prev.voice.stt
  const sttOff = before.enabled && !stt.enabled
  const engineChanged = before.engine !== stt.engine
  const preloadOff = before.preload && !stt.preload
  if (sttOff || engineChanged || preloadOff) releaseSttModels()
  if (prev.voice.tts.enabled && !next.voice.tts.enabled) shutdownTts()
}

export function registerVoiceIpc(): void {
  onAppSettingsChange((next, prev) => {
    releaseDisabledVoice(next, prev)
    syncWhisperServer(next, prev)
  })

  // The package extraction starts through two paths (right after the download or on
  // first use, inside the engine). A single notice covers both: every
  // phase change publishes the new state on `voice:status-changed`.
  onParakeetExtractPhaseChange(() => {
    void emitStatusChanged()
  })

  ipcMain.handle("voice:hardware", () => hardware())

  ipcMain.handle("voice:models", (): VoiceModelInfo[] => VOICE_MODELS)

  ipcMain.handle("voice:status", () => voiceStatusSnapshot())

  /**
   * Warms up a dictation engine IN THE BACKGROUND: the answer comes back at once and the
   * model load runs off the user's path. The microphone button
   * calls it as soon as it appears, so the first dictation does not wait for the model.
   */
  ipcMain.handle(
    "voice:stt:warm",
    (_event, payload: { modelId?: string; engine?: string; threads?: number } = {}) => {
      const modelId = String(payload?.modelId ?? "")
      // Preloading is a preference: when off, the request warms up
      // nothing and the answer says so, instead of promising work that did not happen.
      const warming = sttPreloadEnabled()
      if (warming) void warmSttModel(modelId || undefined, payload?.engine, payload?.threads)
      return { warming }
    },
  )

  /**
   * Releases at once what the dictation engines loaded. The Voice tab fires this
   * when turning preloading off: the RAM comes back right away, instead of waiting for the
   * idle cycle. With dictation in progress, the model postpones the release.
   */
  ipcMain.handle("voice:stt:release", () => {
    releaseSttModels()
    return { released: true }
  })

  ipcMain.handle("voice:download", async (_event, payload: { modelId?: string }) => {
    const modelId = String(payload?.modelId ?? "")
    if (!VOICE_MODELS.some((model) => model.id === modelId)) {
      throw new Error(`unknown model: ${modelId}`)
    }
    // It is already on disk: there is nothing to download, and what may be missing is the PREPARATION of the
    // package (extraction + VAD), triggered here. Without this, clicking an already
    // downloaded model did NOTHING: the download ended at once, skipping the complete
    // files, and the screen did not change.
    if (await isModelDownloaded(modelId)) {
      const model = modelInfo(modelId)
      if (model?.archive) {
        try {
          await prepareSttModel(modelId)
        } catch (err) {
          // The error died here (`.catch(() => {})`): the extraction failed in
          // silence and the "Prepare now" button seemed to do nothing. The notice
          // goes through the progress channel, which the model list already shows.
          const failure: VoiceDownloadProgress = {
            modelId,
            received: 0,
            total: model.bytes,
            done: true,
            error: (err as Error).message ?? String(err),
          }
          emit("voice:download-progress", failure)
        }
      }
      await emitStatusChanged()
      return { started: false }
    }
    const started = startDownload(modelId, (progress: VoiceDownloadProgress) => {
      emit("voice:download-progress", progress)
      // End (or failure) of the download: the state changed — announce it and, if it is a package,
      // extract right after (see `aposDownload`).
      if (progress.done) void afterDownload(modelId, progress)
    })
    // The download started: "absent" became "downloading" just now.
    if (started.started) void emitStatusChanged()
    return started
  })

  ipcMain.handle("voice:download-cancel", (_event, payload: { modelId?: string }) => {
    cancelDownload(String(payload?.modelId ?? ""))
  })

  ipcMain.handle("voice:remove-model", async (_event, payload: { modelId?: string }) => {
    const modelId = String(payload?.modelId ?? "")
    // The engine keeps the ONNX files open in memory: deleting the TTS with it up
    // would leave the process reading files that no longer exist.
    if (modelId === TTS_MODEL_ID) shutdownTts()
    await removeModel(modelId)
    await emitStatusChanged()
  })

  ipcMain.handle(
    "voice:tts:start",
    (
      _event,
      payload: SpeechRequest,
    ): { id: string } => {
      const id = randomUUID()
      const controller = new AbortController()
      speechJobs.set(id, controller)
      const text = String(payload?.text ?? "")

      // The work continues in the background: the renderer receives the id at once and
      // follows it through the events (that is what streaming exists to allow).
      void (async () => {
        try {
          await runSpeech(id, text, payload, controller.signal)
          emit("voice:tts:done", { id })
        } catch (err) {
          emit("voice:tts:done", { id, error: (err as Error).message ?? String(err) })
        } finally {
          speechJobs.delete(id)
        }
      })()

      return { id }
    },
  )

  ipcMain.handle("voice:tts:cancel", (_event, payload: { id?: string }) => {
    speechJobs.get(String(payload?.id ?? ""))?.abort()
  })

  // CONTINUOUS speech (call mode): a single utterance, opened before any text exists, which
  // receives sentences as the agent writes them. The main synthesises the next
  // sentence while the previous one is still playing in the renderer — with one utterance per sentence,
  // each waited for the previous one to finish playing before it started being generated, and
  // the silence between "Claro." and the rest was exactly that synthesis time.
  // The chunks come out through the same `voice:tts:chunk`/`done`, with the same id.
  ipcMain.handle("voice:tts:stream-start", (_event, payload: SpeechRequest = {}): { id: string } => {
    const id = randomUUID()
    const controller = new AbortController()
    speechJobs.set(id, controller)
    streams.set(id, {
      request: payload,
      queue: [],
      next: 0,
      closed: false,
      running: false,
      signal: controller.signal,
      language: {},
    })
    return { id }
  })

  ipcMain.handle("voice:tts:stream-append", (_event, payload: { id?: string; text?: string }) => {
    const stream = streams.get(String(payload?.id ?? ""))
    const text = String(payload?.text ?? "").trim()
    if (!stream || stream.closed || !text) return
    stream.queue.push({ text, seg: stream.next++ })
    void drainStream(String(payload.id))
  })

  // Discards the sentences that have not started being generated yet (the utterance stays
  // open). Call mode uses it when the agent goes off to the tools: what it
  // narrated before that, besides the waiting sentence, should not be read.
  ipcMain.handle("voice:tts:stream-clear", (_event, payload: { id?: string }) => {
    const stream = streams.get(String(payload?.id ?? ""))
    if (stream) stream.queue = []
  })

  ipcMain.handle("voice:tts:stream-end", (_event, payload: { id?: string }) => {
    const id = String(payload?.id ?? "")
    const stream = streams.get(id)
    if (!stream) return
    stream.closed = true
    void drainStream(id)
  })

  // Dictation. The channels were missing: the renderer called `voice:stt:start` and the main
  // answered "No handler registered" — the bridge below existed with nobody
  // wiring it to the IPC.
  ipcMain.handle(
    "voice:stt:start",
    async (event, payload: Partial<VoiceSttSessionStart> = {}): Promise<{ id: string }> => {
      const sender = event.sender
      // The partial goes only to the window that opened the session; the id only exists after
      // the start, and the engine only produces a partial after the first push.
      let id = ""
      const session = await startVoiceSttSession(
        {
          engine: payload.engine as VoiceEngineId,
          modelId: payload.modelId ?? null,
          language: payload.language,
          threads: payload.threads,
          sampleRate: Number(payload.sampleRate) || 16000,
          live: payload.live ?? true,
        },
        (text) => {
          if (id && !sender.isDestroyed()) sender.send("voice:stt:partial", { id, text })
        },
      )
      id = session.id
      // Window closed in the middle of the speech: the session (and the engine) are not left orphaned.
      sender.once("destroyed", () => void cancelVoiceSttSession(id).catch(() => {}))
      return session
    },
  )

  ipcMain.handle("voice:stt:push", (_event, payload: { id?: string; pcm?: string }) => {
    if (!payload?.id || !payload.pcm) return
    pushVoiceSttAudio(payload.id, Buffer.from(payload.pcm, "base64"))
  })

  ipcMain.handle("voice:stt:stop", (_event, payload: { id?: string }) =>
    stopVoiceSttSession(String(payload?.id ?? "")),
  )

  ipcMain.handle("voice:stt:cancel", (_event, payload: { id?: string }) =>
    cancelVoiceSttSession(String(payload?.id ?? "")),
  )
}

// ---------------------------------------------------------------------- STT
//
// Bridge to the STT module (another worker, ./stt.ts): the agreed format is
// `{ id }` when the session opens + `onPartial(text)` for the live text.

export interface VoiceSttSessionStart {
  engine: VoiceEngineId
  /** Rate of the PCM that will be pushed (16 kHz on the default capture; the engine resamples). */
  sampleRate: number
  modelId?: string | null
  language?: string
  threads?: number
  /** Live text while the speech happens (default: yes). */
  live?: boolean
  /** Segments with timing (file transcription); 'words' = per word. */
  timestamps?: boolean | 'words'
}

export interface VoiceTranscribeResult {
  text: string
  audioMs: number
  ms: number
  segments?: SttSegment[]
}

/** State of the dictation engines — it is the snapshot the phone queries. */
export async function voiceStatus(): Promise<VoiceStatusResponse> {
  const engines = await sttEngineStatus()
  return { ready: engines.some((e) => e.installed && e.available), engines }
}

/**
 * Opens a dictation session and hooks up the live text. Returns the session id — it is
 * what ties the following `pushVoiceSttAudio`/`stopVoiceSttSession` together.
 */
export async function startVoiceSttSession(
  options: VoiceSttSessionStart,
  onPartial: (text: string) => void,
): Promise<{ id: string }> {
  const session = await startSttSession(
    {
      engine: options.engine,
      modelId: options.modelId,
      language: options.language,
      threads: options.threads,
      sampleRate: options.sampleRate,
      live: options.live ?? true,
      timestamps: options.timestamps,
    },
    onPartial,
  )
  return { id: session.id }
}

/** A PCM chunk (same rate informed at start) of the session. */
export function pushVoiceSttAudio(id: string, pcm: Buffer): void {
  pushSttAudio(id, pcm)
}

/** End of the speech: closes the last segment and returns the final text. */
export async function stopVoiceSttSession(id: string): Promise<VoiceTranscribeResult> {
  const out = await stopSttSession(id)
  return { text: out.text, audioMs: out.audioMs, ms: out.ms, segments: out.segments }
}

/** Cancels the session without waiting for text (Esc, window closed…). */
export async function cancelVoiceSttSession(id: string): Promise<void> {
  await cancelSttSession(id)
}

/**
 * Transcribes a block of PCM in one go (already recorded audio, no live dictation):
 * opens the session, pushes everything and closes it. It is the path of whoever sends a whole
 * voice note (the phone, for instance) and does not want an open session.
 *
 * Without `engine` in the request, the choice is: the engine already ready to run
 * now (installed and available) and, if none is, the one recommended by the
 * hardware — the same rule the voice screen shows.
 */
export async function transcribePcm(
  pcm: Buffer,
  opts: {
    sampleRate: number
    engine?: VoiceEngineId
    modelId?: string | null
    language?: string
    timestamps?: boolean | 'words'
  },
): Promise<VoiceTranscribeResult> {
  if (!pcm || pcm.length === 0) throw new Error("empty PCM")
  const engine = opts.engine ?? (await defaultEngine())
  const { id } = await startVoiceSttSession(
    {
      engine,
      modelId: opts.modelId,
      language: opts.language,
      sampleRate: opts.sampleRate,
      // With no live value: a single pass, without a partial in the middle of the audio.
      live: false,
      timestamps: opts.timestamps,
    },
    () => {},
  )
  try {
    pushVoiceSttAudio(id, pcm)
  } catch (err) {
    await cancelVoiceSttSession(id)
    throw err
  }
  return await stopVoiceSttSession(id)
}

/** Engine worth trying now: the ready one, otherwise the recommended one. */
async function defaultEngine(): Promise<VoiceEngineId> {
  const engines = await sttEngineStatus()
  const ready = engines.find((e) => e.installed && e.available)
  if (ready) return ready.engine
  return (await hardware()).recommendedEngine
}

/** STT catalog for whoever needs it outside the IPC (e.g. validation). */
export function sttModels(): VoiceModelInfo[] {
  return STT_MODELS
}

/** TTS engine state (diagnostics: `voice:status` already brings the summary). */
export async function voiceTtsStatus(): Promise<Awaited<ReturnType<typeof ttsStatus>>> {
  return await ttsStatus()
}

/** Shuts the TTS engine down now (the idle shutdown is automatic). */
export function shutdownVoice(): void {
  shutdownTts()
}

// ------------------------------------------------- audio files (tools)

/**
 * Text → WAV file, through the same engine as reading aloud (the preferences'
 * audio priority: provider, with the local one as fallback). It is what the
 * audio_generate tool delivers. Long text goes in parts (the provider route accepts
 * ~4 thousand characters per request); the chunks are spliced into a single file.
 */
export async function synthesizeToWav(
  text: string,
  opts: { voice?: string; lang?: string; speed?: number } = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<{ wav: Buffer; durationMs: number }> {
  const tts = getAppSettings().voice.tts
  const payload: SpeechRequest = {
    voice: opts.voice ?? tts.voice,
    lang: opts.lang ?? tts.lang,
    speed: opts.speed ?? tts.speed,
    engine: tts.engine,
  }
  const pieces: Float32Array[] = []
  let rate = 0
  // One file, one language: the parts of a long text inherit the first one's.
  const language: { lang?: string } = {}
  for (const part of splitForSynthesis(text)) {
    await synthesize(part, payload, signal, (chunk) => {
      const samples = pcm16ToFloat32(chunk.pcm)
      if (!rate) rate = chunk.sr
      // The local fallback may speak at a different rate from the provider: everything at the first one.
      pieces.push(chunk.sr === rate ? samples : resampleLinear(samples, chunk.sr, rate))
    }, language)
  }
  if (!rate || pieces.length === 0) throw new Error("the speech engine returned no audio")
  const all = concatFloat32(pieces)
  return { wav: encodeWavPcm16(all, rate), durationMs: samplesToMs(all.length, rate) }
}

/**
 * PCM16 mono 16 kHz (from `decodeAudioFile`) → text, through the preferences'
 * dictation engine. Long files go in windows of a few minutes, cut at the
 * quietest stretch near each boundary (see `splitPcmWindows`): the
 * closing of a dictation session has a short deadline, made for live
 * speech, and a half-hour file in a single session would blow that deadline.
 */
export async function transcribeAudioPcm(
  pcm: Buffer,
  opts: { language?: string; timestamps?: boolean | 'words' } = {},
): Promise<{ text: string; engine: VoiceEngineId; segments: SttSegment[] }> {
  const stt = getAppSettings().voice.stt
  const engines = await sttEngineStatus()
  const chosen = engines.find((e) => e.engine === stt.engine)
  if (!chosen?.available || !chosen.installed) {
    throw new Error(
      `the dictation engine (${stt.engine}) is not ready${chosen?.reason ? `: ${chosen.reason}` : ""} — see Settings → Voice`,
    )
  }
  const samples = pcm16ToFloat32(pcm)
  const texts: string[] = []
  const segments: SttSegment[] = []
  for (const [start, end] of splitPcmWindows(samples, STT_SAMPLE_RATE)) {
    const pcmWindow = float32ToPcm16(samples.subarray(start, end))
    const out = await transcribePcm(pcmWindow, {
      sampleRate: STT_SAMPLE_RATE,
      engine: stt.engine,
      modelId: stt.modelId,
      language: opts.language || stt.language,
      timestamps: opts.timestamps,
    })
    if (out.text.trim()) texts.push(out.text.trim())
    // Each window's timings start at zero: shift them to the file's time.
    const offset = samplesToMs(start, STT_SAMPLE_RATE)
    for (const seg of out.segments ?? []) {
      segments.push({
        startMs: seg.startMs + offset,
        endMs: seg.endMs + offset,
        text: seg.text,
        ...(seg.words
          ? { words: seg.words.map((w) => ({ startMs: w.startMs + offset, endMs: w.endMs + offset, text: w.text })) }
          : {}),
      })
    }
  }
  return { text: texts.join(" "), engine: stt.engine, segments }
}
