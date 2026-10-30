/**
 * Voice dictation (STT) in the MAIN process — the public facade.
 *
 * Two engines, both local and cloudless:
 *   - **parakeet**: sherpa-onnx (N-API addon, runs in Electron without a rebuild), CPU,
 *     Silero VAD slicing the audio for live text — the Windows and
 *     Linux candidate (see `parakeet.ts`);
 *   - **whisper**: whisper.cpp as a HELPER PROCESS `whisper-server`, ggml models
 *     downloaded on demand, explicit greedy decoding (see `whisper.ts`).
 *
 * The renderer sends audio at 16 kHz mono PCM16; both engines work at 16 kHz,
 * so on the common path NOTHING is resampled. `StreamResampler` only comes in if the rate
 * arrives different — should the engine ever require another rate.
 *
 * `STT_MODELS` is also the source of the core's catalog (`manifest.ts` joins this
 * list with the TTS one), which is why each entry follows `VoiceModelInfo` to the letter: `bytes`
 * is the exact download size and `url` points at the file directly.
 */

import { randomUUID } from 'node:crypto'
import type { VoiceEngineId, VoiceEngineStatus, VoiceModelInfo } from '@shared/voice'
import { getAppSettings } from '../app-settings'
import { getSttModel, STT_MODEL_DEFS } from './catalog'
import { ensureParakeetExtracted, fileComplete, isParakeetReady } from './models-store'
import { parakeetEngine } from './parakeet'
import { whisperAutoModelId, whisperEngine } from './whisper'
import { pcm16ToFloat32, samplesToMs, STT_SAMPLE_RATE, StreamResampler } from './audio'
import type { SttEngine, SttHandle, SttSegment } from './engine'

/**
 * Declarative catalog of the dictation models: id, engine, label, bytes, URL and
 * languages. Nothing is downloaded here — the download is on demand (`download.ts`) and
 * the installation state comes out of `sttEngineStatus()`.
 */
export const STT_MODELS: VoiceModelInfo[] = STT_MODEL_DEFS.map((m) => ({
  id: m.id,
  kind: 'stt',
  engine: m.engine,
  label: m.label,
  bytes: m.bytes,
  url: m.url,
  sha256: m.sha256,
  langs: m.langs,
  archive: m.archive,
}))

const ENGINES: Record<VoiceEngineId, SttEngine> = {
  parakeet: parakeetEngine,
  whisper: whisperEngine,
}

/**
 * The model is USABLE by the engine right now — it is the answer `voice:status`
 * publishes as `installed`. For Parakeet it is the EXTRACTED package with the
 * Silero VAD present; for whisper it is the complete file (there is no extraction).
 */
export function sttModelInstalled(modelId: string): boolean {
  const def = getSttModel(modelId)
  if (!def) return false
  if (def.archive) return isParakeetReady()
  return fileComplete(def)
}

/**
 * Makes an already downloaded model ready for use (extracts the package when
 * that is the case). Idempotent: a ready model resolves at once, without touching the file.
 * The core's download calls this as soon as it finishes; the engine also calls it on
 * first use, so extraction never depends on a single path.
 */
export async function prepareSttModel(modelId: string): Promise<void> {
  const def = getSttModel(modelId)
  if (def?.archive) await ensureParakeetExtracted()
}

/**
 * Warms up a dictation engine IN THE BACKGROUND — the user's first session does not
 * pay for loading the model (in Parakeet, hundreds of MB in the ONNX Runtime).
 *
 * It never rejects: the error, if any, shows up in the engine's `status()`. Idempotent,
 * so it can be fired carelessly — the microphone button calls it every time it
 * shows up and the end of a download calls it on its own.
 */
export async function warmSttModel(modelId?: string | null, engine?: string, threads?: number): Promise<void> {
  if (!sttPreloadEnabled()) return
  const def = modelId ? getSttModel(modelId) : null
  // An id that is not a dictation one (a speech model, for instance) warms nothing up.
  if (modelId && !def) return
  const engineId = (def?.engine ?? engine) as VoiceEngineId | undefined
  const impl = engineId ? ENGINES[engineId] : undefined
  await impl?.warm?.(modelId ?? null, threads)
  scheduleRelease()
}

/**
 * Is preloading on? Without it nobody warms up ahead of time: the
 * first dictation is what pays for the loading (the trade is RAM for waiting, and the
 * user decides). It comes from the main's settings, not from the payload.
 */
export function sttPreloadEnabled(): boolean {
  const settings = getAppSettings() as { voice?: { stt?: { preload?: unknown; enabled?: unknown } } } | null
  // Dictation turned off also does not preload: no caller (the button, the end
  // of a download) should pin the model in the memory of whoever turned voice off.
  return settings?.voice?.stt?.preload !== false && settings?.voice?.stt?.enabled !== false
}

/** How long without dictation before releasing the model `warm` loaded. */
const IDLE_RELEASE_MS = 5 * 60_000

let idleTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Releases NOW what the engines loaded, without waiting for the idle cycle. It is what
 * toggling the preload preference fires: turning preload off gives the
 * RAM back right away, instead of in five minutes.
 *
 * With an open session the model is in use: it does not release it mid-session, it postpones.
 */
export function releaseSttModels(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (sessions.size > 0) {
    scheduleRelease()
    return
  }
  for (const engine of Object.values(ENGINES)) {
    try {
      engine.release?.()
    } catch {
      // releasing is best-effort: it never takes the main down
    }
  }
}

/**
 * Marks dictation activity and (re)schedules the release: after the idle time with no
 * open session, what was loaded is released — in Parakeet that is hundreds of MB
 * resident. A session in progress postpones the release.
 */
function scheduleRelease(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    releaseSttModels()
  }, IDLE_RELEASE_MS)
  idleTimer.unref?.()
}

/** State of each engine so the UI can build the selectors and the download button. */
export async function sttEngineStatus(): Promise<VoiceEngineStatus[]> {
  const statuses = await Promise.all([parakeetEngine.status(), whisperEngine.status()])
  return statuses.map((s) => ({
    engine: s.engine,
    installed: s.installed,
    available: s.available,
    // "Downloaded" is the file on disk (for Parakeet, the .tar.bz2 itself): the
    // engine may not have extracted the package — and the UI needs to know that so it
    // does not call "not downloaded" what is already there.
    downloaded: STT_MODEL_DEFS.some((m) => m.engine === s.engine && fileComplete(m)),
    reason: s.reason,
    autoModelId: s.engine === 'whisper' ? whisperAutoModelId() : ENGINES[s.engine].defaultModelId,
  }))
}

/** Open dictation session (the engine and the audio live in the main). */
export interface SttSession {
  id: string
}

interface ActiveSession {
  id: string
  engineId: VoiceEngineId
  handle: SttHandle
  /** Resampler only when the input rate differs from 16 kHz. */
  resampler: StreamResampler | null
  inputSamples: number
  inputRate: number
  startedAt: number
}

const sessions = new Map<string, ActiveSession>()

/** Shape of the start input (the public API declares it inline). */
interface StartSttInput {
  engine: VoiceEngineId
  modelId?: string | null
  language?: string
  /** Rate of the audio the renderer will send (16 kHz on the default capture). */
  sampleRate: number
  threads?: number
  /** Ask for live text while the speech happens. */
  live: boolean
  /** Ask for the segments with timing (file transcription); 'words' = per word. */
  timestamps?: boolean | 'words'
}

/**
 * Opens a dictation session. It only resolves when the model is loaded and ready
 * (Parakeet extracts the package and warms the ONNX Runtime; whisper waits for the
 * server's `/health`): a preparation error comes out here, not in the middle of the speech.
 */
export async function startSttSession(
  input: StartSttInput,
  onPartial: (text: string) => void,
): Promise<SttSession> {
  const engine = ENGINES[input.engine]
  if (!engine) throw new Error(`motor de ditado desconhecido: ${String(input.engine)}`)

  const rate = input.sampleRate > 0 ? input.sampleRate : STT_SAMPLE_RATE
  const partial = (text: string): void => {
    try {
      onPartial(text)
    } catch {
      // the callback belongs to the caller; an error in it cannot take the engine down
    }
  }

  const handle = await engine.start(
    {
      modelId: input.modelId ?? null,
      language: input.language || 'pt',
      threads: input.threads,
      live: Boolean(input.live),
      timestamps: input.timestamps || false,
    },
    partial,
  )

  const id = randomUUID()
  sessions.set(id, {
    id,
    engineId: engine.id,
    handle,
    resampler: rate === STT_SAMPLE_RATE ? null : new StreamResampler(rate, STT_SAMPLE_RATE),
    inputSamples: 0,
    inputRate: rate,
    startedAt: Date.now(),
  })
  // An open session is activity: the model cannot be released while it lasts.
  scheduleRelease()
  return { id }
}

/**
 * Capture audio: PCM16LE mono at the rate declared in start.
 *
 * It is `void` on purpose — the audio path is hot and cannot wait; a
 * session already closed simply discards the chunk.
 */
export function pushSttAudio(id: string, pcm: Buffer): void {
  const s = sessions.get(id)
  if (!s) return
  const floats = pcm16ToFloat32(pcm)
  s.inputSamples += floats.length
  s.handle.pushAudio(s.resampler ? s.resampler.push(floats) : floats)
}

/** Closes the session and returns the final text, the audio duration and the time spent. */
export async function stopSttSession(
  id: string,
): Promise<{ text: string; audioMs: number; ms: number; segments?: SttSegment[] }> {
  const s = sessions.get(id)
  if (!s) throw new Error(`dictation session does not exist: ${id}`)
  sessions.delete(id)
  const t0 = Date.now()
  const result = await s.handle.stop()
  // The end of a session is activity: the idle-release count restarts here.
  scheduleRelease()
  return {
    text: result.text,
    audioMs: samplesToMs(s.inputSamples, s.inputRate),
    ms: Date.now() - t0,
    segments: result.segments,
  }
}

/** Aborts the session without transcribing (the user pressed Esc, the window closed…). */
export async function cancelSttSession(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  await s.handle.cancel()
  scheduleRelease()
}
