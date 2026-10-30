/**
 * Voice core (text→speech and speech→text) running LOCALLY, in the main process.
 *
 * Two independent engines, with one rule in common: the WEIGHT of the model never
 * enters the build. The app downloads on demand to `<userData>/voice/models/<id>` and,
 * after that, works 100 % offline — the only network there is, is the download.
 *
 *  - TTS: Supertonic 3 (ONNX Runtime, CPU). Default voice F2, language pt.
 *  - STT: Parakeet TDT 0.6B v3 (sherpa-onnx) or whisper.cpp — the choice per
 *    machine comes from `VoiceHardwareInfo` (see hardware.ts in the main).
 *
 * `VoiceEngineId` covers only the STT engines on purpose: the TTS is a single one
 * ("supertonic") and is not chosen by hardware.
 */

/** Transcription engine (speech→text) available on the machine. */
export type VoiceEngineId = "parakeet" | "whisper"

/**
 * Where the speech is SYNTHESIZED.
 *
 *  - `model`: through the MODEL route (AI provider) when there is one — it is the
 *    default. With no provider configured, or with the route failing, the pipeline falls
 *    back to the local engine: the preference never leaves the reading mute.
 *  - `local`: always through the local engine (Supertonic 3), 100 % offline.
 */
export type VoiceTtsEngine = "model" | "local"

/** Nature of the model: synthesizes speech (tts) or transcribes audio (stt). */
export type VoiceModelKind = "tts" | "stt"

/**
 * The two voice functions, which are turned on and off separately in the Preferences.
 * Turned off, the tool is not even registered in the turn.
 */
export type VoiceFeature = VoiceModelKind

/**
 * A downloadable model (single STT file, or the TTS bundle of files).
 * `bytes` is the total the download takes on disk, not the size of a specific
 * file — it is the number the UI shows before the user decides to download.
 */
export interface VoiceModelInfo {
  /** stable id; it is also the folder name in `<userData>/voice/models/<id>`. */
  id: string
  kind: VoiceModelKind
  /** Engine that consumes the model ("supertonic", "parakeet", "whisper"). */
  engine: string
  /** Label for the UI, with what the model does and how much it weighs. */
  label: string
  /** Total size of the download, in bytes. */
  bytes: number
  /** Origin of the files (the file, or the model page when it is a bundle). */
  url: string
  /** sha256 of the file, when the origin publishes one per model. */
  sha256?: string
  /** Languages covered (short ISO/BCP-47 codes), when the model limits them. */
  langs?: string[]
  /**
   * The model comes as a BUNDLE (e.g. the Parakeet `.tar.bz2`) and has to be
   * EXTRACTED before the engine uses it. A downloaded bundle is not "ready" yet.
   */
  archive?: boolean
}

/** Progress of a download in progress (event `voice:download-progress`). */
export interface VoiceDownloadProgress {
  modelId: string
  /** Bytes already on disk (sum of the files of the model). */
  received: number
  /** Total bytes of the model — 0 until the origin informs the content-length. */
  total: number
  done: boolean
  /** Filled when it finished with an error (network, disk, integrity). */
  error?: string
}

/**
 * What the machine is able to run — the `voice:hardware` returns this so the UI
 * can explain the choice instead of only showing it. `reason` and `warnings` ALWAYS
 * come filled: a recommendation without a justification becomes a black box.
 */
export interface VoiceHardwareInfo {
  platform: string
  arch: string
  /** Total RAM of the machine, in GB (GiB rounded to 0.1). */
  totalMemGb: number
  cpus: number
  recommendedEngine: VoiceEngineId
  /** id of a model from the catalog (`voice:models`) — not a free string. */
  recommendedModel: string
  /** Why this engine/model, on this machine, in one sentence. */
  reason: string
  /** What can go wrong anyway (low memory, model not downloaded...). */
  warnings: string[]
}

/** Availability of a transcription engine (without touching any model). */
export interface VoiceEngineStatus {
  engine: VoiceEngineId
  /** The engine's artifact is on disk (the chosen model was downloaded). */
  installed: boolean
  /**
   * The BYTES of the model are on disk — what the downloader knows, without opining whether the
   * engine can already use them (the Parakeet bundle stays like this before extraction).
   * It is what keeps the badge from saying "not downloaded" next to a text saying it
   * downloaded; whoever answers "can it be used?" is `installed`/`available`.
   */
  downloaded?: boolean
  /** It can run NOW on this machine (binary exists/compiles, arch supported). */
  available: boolean
  /** Reason, whenever `available` is false (or when something is worth warning about). */
  reason?: string
  /**
   * The model the engine uses with "Automatic" (null `modelId`) — whoever decides
   * is the engine, so the screen shows the "In use" from here instead of guessing.
   */
  autoModelId?: string
}

/**
 * Fine state of a model on disk. It is the SINGLE source of the badge ("installed") and of
 * the reason text: both come out of this same portrait, so they cannot disagree.
 *
 *   absent      nothing on disk
 *   partial     interrupted/canceled download (there are bytes, not the whole model)
 *   downloading download in progress
 *   downloaded  complete and checked bytes, but the engine CANNOT use them yet
 *               (it is the case of the bundle still to be extracted)
 *   extracting  bundle extraction in progress
 *   ready       the engine can use it NOW (equivalent to `installed`)
 *   error       the last operation failed (download or extraction)
 */
export type VoiceModelState =
  | "absent"
  | "partial"
  | "downloading"
  | "downloaded"
  | "extracting"
  | "ready"
  | "error"

/** Portrait of ONE model of the catalog — the honest answer to "can it be used?". */
export interface VoiceModelStatus {
  /**
   * The bytes are on disk and checked (EXACT size of each file; the
   * sha256 is checked at the end of the download). It does not mean it can be used: a
   * bundle stays `downloaded` and still needs extraction.
   */
  downloaded: boolean
  /**
   * The ENGINE can use the model now. For Parakeet this is the EXTRACTED bundle
   * with the Silero VAD present; for TTS and the whisper models it is the
   * complete file. The UI badge and the reason text must come from here
   * (`installed` + `state` + `reason`), never from the downloader state.
   */
  installed: boolean
  /**
   * Same as `installed`, with the explicit name the renderer already expected
   * (`downloaded` for "the bytes arrived", `ready` for "it can be used").
   */
  ready: boolean
  /** Fine state; `ready` is the only state in which `installed` is true. */
  state: VoiceModelState
  /** Bytes already on disk (includes the `.part` of a resumable download). */
  received: number
  /** Total bytes expected (`VoiceModelInfo.bytes`). */
  total: number
  /** Why it is NOT usable now, when `installed` is false. */
  reason?: string
  /** The concrete failure when `state === "error"`. */
  error?: string
}

/** Portrait of the voice core for the settings screen. */
export interface VoiceStatusSnapshot {
  /** State per catalog id (TTS and STT) — same source for badge and reason. */
  models: Record<string, VoiceModelStatus>
  engines: VoiceEngineStatus[]
  /** The TTS engine is REALLY usable: model present/valid + engine in the build. */
  ttsReady: boolean
  /**
   * Speech route THROUGH THE MODEL (AI provider). It is the half of the audio
   * priority that does not depend on the disk: with no provider configured with speech, the
   * "model" preference falls back to the local engine and the UI says why.
   */
  modelTts?: VoiceModelTtsStatus
}

/** Availability of speech synthesis through the AI provider ("Voice model" preference). */
export interface VoiceModelTtsStatus {
  /** There is a usable speech route now (provider configured + speech model). */
  available: boolean
  /** Provider and model the route would use, when available. */
  providerId?: string
  modelId?: string
  /** Reason for being unavailable — the speech then comes out through the local engine. */
  reason?: string
}

/** TTS preferences (text→speech). */
export interface VoiceTtsSettings {
  enabled: boolean
  /** Supertonic voice: M1–M5 (male) or F1–F5 (female). */
  voice: string
  /** Language code (`pt`, `en`, …) or `na` (agnostic). */
  lang: string
  /** Speed factor, 0.5–2.0 (1 = natural). */
  speed: number
  /**
   * Audio priority: where the speech is synthesized. `model` (default) tries
   * the provider route and, without it, uses the local engine; `local` forces the local
   * engine. See `VoiceTtsEngine`.
   */
  engine: VoiceTtsEngine
}

/** STT preferences (speech→text). */
export interface VoiceSttSettings {
  enabled: boolean
  engine: VoiceEngineId
  /** id of the chosen STT model; null = use the one recommended by the hardware. */
  modelId: string | null
  /** Language of the speech (`pt`, `en`, …) or `auto` when the engine detects it on its own. */
  language: string
  /** Live text while the person speaks (the engine decides how to publish it). */
  live: boolean
  /** Inference threads (3–4 is the measured sweet spot; see vozlab §18). */
  threads: number
  /**
   * Preloads the dictation model: RAM in exchange for instant dictation.
   *
   * On (default), the engine warms up as soon as the download finishes and when the
   * microphone shows up, and releases the model after an idle time. Off,
   * only the first dictation pays for the load — and it sits waiting.
   */
  preload: boolean
  /**
   * Microphone of the capture (`deviceId` of `enumerateDevices`); null = the system
   * default. It applies to dictation and to call mode (both open the
   * microphone through the same hook). A device that vanished falls back to the default.
   */
  micDeviceId: string | null
}

/** Options of the silence that ends the speech in call mode (ms). */
export const VOICE_CALL_SILENCE_OPTIONS = [900, 1300, 1800, 2500] as const

/**
 * Call mode: real-time voice conversation — dictation listens (with live
 * preview), speech reads the answer while it arrives, and the agent answers short.
 */
export interface VoiceCallSettings {
  /** Shows the call button next to the microphone. */
  enabled: boolean
  /** Silence (ms) after the speech that ends your turn and sends the message. */
  silenceMs: number
}

export interface VoiceSettings {
  tts: VoiceTtsSettings
  stt: VoiceSttSettings
  call: VoiceCallSettings
}

/**
 * Defaults of the voice core: speech in pt-BR from the first click, with the
 * audio priority on the MODEL (falls back to the local engine when there is no route).
 */
export const VOICE_DEFAULTS: VoiceSettings = {
  tts: { enabled: true, voice: "F2", lang: "auto", speed: 1, engine: "model" },
  stt: { enabled: true, engine: "parakeet", modelId: null, language: "auto", live: true, threads: 4, preload: true, micDeviceId: null },
  call: { enabled: true, silenceMs: 1300 },
}
