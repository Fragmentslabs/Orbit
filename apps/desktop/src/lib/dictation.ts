import type { AppSettings } from "@shared/app-settings"
import { VOICE_DEFAULTS, type VoiceSttSettings } from "@shared/voice"

/**
 * Pure dictation pieces: preferences, text, PCM→base64 and the engine state.
 * They live outside the hook/component so they can be tested without a DOM (the rest —
 * microphone, worklet and IPC — only exists inside the app).
 */

/** Capture rate: the main contract expects 16 kHz mono PCM16. */
export const DICTATION_SAMPLE_RATE = 16000

/** Frames per chunk sent to main: 2048 at 16 kHz = 128 ms. */
export const DICTATION_CHUNK_FRAMES = 2048

/** Name of the processor registered in the worklet (public/pcm-capture-worklet.js). */
export const PCM_WORKLET_PROCESSOR = "orbit-pcm-capture"

export type { VoiceSttSettings }

/** The `voice` block comes from the normalized AppSettings, but may be missing (localStorage
 *  from an older version, raw AppSettings in a test): reading from here never throws. */
type VoiceSettingsCarrier = { voice?: { stt?: Partial<VoiceSttSettings> } }

function rawStt(settings: AppSettings | null | undefined): Partial<VoiceSttSettings> | undefined {
  if (!settings) return undefined
  const stt = (settings as unknown as VoiceSettingsCarrier).voice?.stt
  return stt && typeof stt === "object" ? stt : undefined
}

const str = (value: unknown, fallback: string): string => (typeof value === "string" && value ? value : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

/** Dictation preferences, with the shared defaults when the block is missing. */
export function resolveVoiceSttSettings(settings: AppSettings | null | undefined): VoiceSttSettings {
  const stt = rawStt(settings)
  const d = VOICE_DEFAULTS.stt
  return {
    enabled: bool(stt?.enabled, d.enabled),
    // The engine comes from a selector that only offers the contract ids; an odd
    // value saved on disk dies at start, with an error from main itself.
    engine: str(stt?.engine, d.engine) as VoiceSttSettings["engine"],
    modelId: typeof stt?.modelId === "string" && stt.modelId ? stt.modelId : null,
    language: str(stt?.language, d.language),
    live: bool(stt?.live, d.live),
    threads: typeof stt?.threads === "number" && Number.isFinite(stt.threads) ? stt.threads : d.threads,
    preload: bool(stt?.preload, d.preload),
    micDeviceId: typeof stt?.micDeviceId === "string" && stt.micDeviceId ? stt.micDeviceId : null,
  }
}

export interface VoiceStatusItem {
  id: string
  /** Engine that owns the item, when the payload reports it. */
  engine?: string
  downloaded?: boolean
  available?: boolean
}

export interface VoiceStatus {
  engines: VoiceStatusItem[]
  models: VoiceStatusItem[]
}

/** Accepts the item from a list (the id comes from inside) or from a map by id (the id
 *  comes from the key) — `voice:status` uses both shapes. */
function toItem(raw: unknown, fallbackId = ""): VoiceStatusItem | null {
  if (typeof raw === "string" && raw) return { id: raw }
  if (typeof raw === "boolean") return fallbackId ? { id: fallbackId, downloaded: raw } : null
  if (!raw || typeof raw !== "object") return fallbackId ? { id: fallbackId } : null
  const value = raw as Record<string, unknown>
  const id = str(fallbackId, str(value.id, str(value.name, str(value.engine, ""))))
  if (!id) return null
  const item: VoiceStatusItem = { id }
  if (typeof value.engine === "string") item.engine = value.engine
  // `installed` and `downloaded` are the same fact under different names across the
  // engines (Parakeet says installed, whisper says downloaded).
  const downloaded =
    typeof value.downloaded === "boolean"
      ? value.downloaded
      : typeof value.installed === "boolean"
        ? value.installed
        : undefined
  if (downloaded !== undefined) item.downloaded = downloaded
  if (typeof value.available === "boolean") item.available = value.available
  return item
}

function toItems(raw: unknown): VoiceStatusItem[] | null {
  if (Array.isArray(raw)) {
    return raw.map((entry) => toItem(entry)).filter((item): item is VoiceStatusItem => item !== null)
  }
  // `models` arrives as a map by id: { "small": { installed: true } }.
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => toItem(value, key))
      .filter((item): item is VoiceStatusItem => item !== null)
  }
  return null
}

/** Normalizes the `voice:status` payload. `null` = could not make sense of it (then
 *  nothing is blocked on its account). */
export function parseVoiceStatus(raw: unknown): VoiceStatus | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as { engines?: unknown; models?: unknown }
  const engines = toItems(value.engines)
  const models = toItems(value.models)
  if (!engines && !models) return null
  return { engines: engines ?? [], models: models ?? [] }
}

/**
 * Is the chosen engine/model ready? Without reliable information it answers
 * `true`: blocking the button over a status we could not read would be worse than
 * letting start fail and showing the error on the button itself.
 */
export function voiceTargetReady(status: VoiceStatus | null, engine: string, modelId: string | null): boolean {
  if (!status) return true
  // The engine may show up identified by `id` or by `engine`, depending on the
  // channel — both names count.
  const engineItem = status.engines.find((item) => item.id === engine || item.engine === engine)
  if (engineItem) {
    if (engineItem.available === false) return false
  } else if (status.engines.length > 0) {
    // Main listed the engines it knows and the chosen one is not among them.
    return false
  }
  if (modelId) {
    const matches = status.models.filter((item) => item.id === modelId)
    const model = matches.find((item) => item.engine === engine) ?? matches[0]
    if (!model) return false
    return model.downloaded !== false && model.available !== false
  }
  // With no model chosen, main uses the one recommended for the machine: the signal
  // that a model exists on disk is the engine's own `installed`.
  return engineItem ? engineItem.downloaded !== false : true
}

/**
 * Joins the dictated text to what the user already had in the input — never overwrites.
 * The separator only goes in when it is missing: an empty base does not get a leading space and
 * a base ending in a space/newline does not get another one.
 */
export function appendDictation(base: string, addition: string): string {
  const add = addition.trim()
  if (!add) return base
  if (!base) return add
  return /\s$/.test(base) ? base + add : `${base} ${add}`
}

/** PCM16 → base64 (the IPC contract sends the audio as a base64 string). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ""
  // In blocks: `String.fromCharCode(...bytes)` all at once blows the stack on
  // long captures.
  const BLOCK = 8192
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BLOCK))
  }
  return btoa(binary)
}

/** Worklet URL. `public/` is served at the renderer root (dev and build), so
 *  the path relative to the document works in both — in production the page comes from
 *  `file://…/dist/index.html` and the worklet sits next to it. */
export function pcmWorkletUrl(base: string): string {
  return new URL("pcm-capture-worklet.js", base).href
}

/** Dictation only exists in the app: without the IPC bridge (browser preview) there is no engine. */
export function dictationSupported(): boolean {
  if (typeof window === "undefined" || !window.ipcRenderer) return false
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return false
  return typeof navigator.mediaDevices.getUserMedia === "function"
}

/**
 * Level of a PCM16 block for the recording waveform, in 0..1. Comes from RMS in
 * dB, in a range from -50 dB (room silence) to -5 dB (voice close to the microphone):
 * a linear scale would leave normal speech almost flat on the floor.
 */
export function pcmLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i] / 32768
    sum += sample * sample
  }
  const rms = Math.sqrt(sum / pcm.length)
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db + 50) / 45))
}
