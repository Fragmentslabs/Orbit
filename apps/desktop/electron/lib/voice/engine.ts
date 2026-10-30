/**
 * Internal contract of the dictation engines.
 *
 * `stt.ts` is the public facade (the requested API); each engine implements `SttEngine`
 * and handles its own peculiarity: Parakeet loads an ONNX model on the CPU and
 * slices with VAD; whisper talks to a `whisper-server` (helper process).
 * The facade knows nothing of that — it only passes 16 kHz audio along and receives text.
 *
 * The only type that comes from outside is `VoiceEngineId` (from `@shared/voice`, type-only,
 * so there is no runtime cycle with the core's manifest).
 */

import type { VoiceEngineId } from '@shared/voice'

/** Already normalised session input: audio always at 16 kHz mono. */
export interface SttStartInput {
  /** Chosen model; the engine decides the default when it comes in null. */
  modelId: string | null
  /** Language code ("pt", "en"…) or "auto" for the engine to detect. */
  language: string
  /** Number of CPU threads (engines that accept it); optional. */
  threads?: number
  /** Ask for live text while the speech happens. */
  live: boolean
  /** Ask for the segments with timings (file transcription with timestamps);
   *  `'words'` also asks for the timing of each word (video editing). */
  timestamps?: boolean | 'words'
}

/** Word with its position in the audio (only with `timestamps: 'words'`). */
export interface SttWord {
  startMs: number
  endMs: number
  text: string
}

/** Transcribed segment with its position in the session audio. */
export interface SttSegment {
  startMs: number
  endMs: number
  text: string
  words?: SttWord[]
}

/** An engine session, with the model already loaded/ready. */
export interface SttHandle {
  pushAudio(samples: Float32Array): void
  /** `segments` comes when the engine knows how to give timings (Parakeet: VAD segments;
   *  whisper: server segments, only with `timestamps` requested). */
  stop(): Promise<{ text: string; audioMs: number; segments?: SttSegment[] }>
  cancel(): Promise<void>
}

/** State of an engine (what became `VoiceEngineStatus` in the facade). */
export interface SttEngineStatus {
  engine: VoiceEngineId
  /** The engine can run ON THIS machine (module/binary present and model on disk). */
  available: boolean
  /** Everything is ready to transcribe right now (model loadable without extra preparation). */
  installed: boolean
  /** Explanation when it cannot run (what is missing, where to put it). */
  reason?: string
  /** Diagnostic data for the settings screen. */
  detail?: Record<string, unknown>
}

export interface SttEngine {
  readonly id: VoiceEngineId
  readonly label: string
  /** Model used when `modelId` comes in null. */
  readonly defaultModelId: string
  status(): Promise<SttEngineStatus>
  /**
   * Loads the model BEFORE first use, IN THE BACKGROUND (optional). In
   * Parakeet that is hundreds of MB in the ONNX Runtime; without a warm-up, the
   * user's first session pays for the loading — and the button stays red
   * waiting for it. Idempotent and silent: a load error does not become an exception
   * here, it shows up in `status()`.
   */
  warm?(modelId: string | null, threads?: number): Promise<void>
  /**
   * Releases what `warm` loaded (optional), when dictation goes idle: the
   * model should not occupy RAM for the whole session. The next `warm`/`start`
   * loads it again.
   */
  release?(): void
  start(input: SttStartInput, onPartial: (text: string) => void): Promise<SttHandle>
}
