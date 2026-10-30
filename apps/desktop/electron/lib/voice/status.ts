import type {
  VoiceModelInfo,
  VoiceModelState,
  VoiceModelStatus,
  VoiceStatusSnapshot,
} from "@shared/voice"
import { TTS_MODEL_ID, VOICE_MODELS } from "./manifest"
import { isDownloading, isModelDownloaded, progressOf, receivedBytes } from "./download"
import { parakeetExtractPhase } from "./models-store"
import { modelTtsStatus } from "./model-tts"
import { sttEngineStatus, sttModelInstalled } from "./stt"
import { enginePresent } from "./tts"
import { t } from "../i18n"

/**
 * The SINGLE source of truth for "usable".
 *
 * There used to be two views disagreeing: the downloader called it "installed" as soon as
 * the bytes reached the disk, while the engine only considers ready what it
 * can RUN (the Parakeet package extracted and with the Silero VAD). The UI badge came
 * from one and the reason text from the other — "Not installed" next to "the
 * package is downloaded".
 *
 * Here both things come out of the SAME snapshot, per model:
 *   - `downloaded`: bytes complete and checked on disk (only the downloader knows);
 *   - `installed` : the engine can use it now (only the engine knows).
 * A package downloaded and not yet extracted stays `downloaded: true`,
 * `installed: false`, `state: "downloaded"` — honest and unambiguous.
 */

/** One-sentence reason for the downloaded package that is not usable yet. */

/** Honest snapshot of a model: the badge and the reason come out of here. */
export async function voiceModelStatus(model: VoiceModelInfo): Promise<VoiceModelStatus> {
  const total = model.bytes
  const received = await receivedBytes(model.id)
  const downloaded = await isModelDownloaded(model.id)
  const archive = model.archive === true
  // Only the package (Parakeet) has extraction; for the others `installed` = `downloaded`.
  const extract = archive ? parakeetExtractPhase() : { phase: "idle" as const, error: null }
  const installed = downloaded && (!archive || sttModelInstalled(model.id))

  let state: VoiceModelState
  let reason: string | undefined
  let error: string | undefined

  if (installed) {
    state = "ready"
  } else if (isDownloading(model.id)) {
    state = "downloading"
    reason = await t("voice.status.downloading")
  } else if (archive && downloaded && extract.phase === "extracting") {
    state = "extracting"
    reason = await t("voice.status.extracting")
  } else if (archive && downloaded && extract.phase === "error") {
    state = "error"
    error = extract.error ?? (await t("voice.status.extractFailed"))
    reason = error
  } else if (downloaded) {
    // Only the package gets here: downloaded and not yet extracted.
    state = "downloaded"
    reason = archive ? await t("voice.status.notExtracted") : undefined
  } else {
    const failure = progressOf(model.id)?.error
    if (failure) {
      state = "error"
      error = failure
      reason = failure
    } else if (received > 0) {
      state = "partial"
      reason = await t("voice.status.partial", { received, total })
    } else {
      state = "absent"
      reason = await t("voice.status.absent")
    }
  }

  return { downloaded, installed, ready: installed, state, received, total, reason, error }
}

/** The full snapshot that `voice:status` (and `voice:status-changed`) publishes. */
export async function voiceStatusSnapshot(): Promise<VoiceStatusSnapshot> {
  const models: Record<string, VoiceModelStatus> = {}
  for (const model of VOICE_MODELS) models[model.id] = await voiceModelStatus(model)
  const tts = models[TTS_MODEL_ID]
  return {
    models,
    engines: await sttEngineStatus(),
    // Usable NOW = Supertonic model present and valid AND the engine in the build.
    ttsReady: tts?.installed === true && enginePresent(),
    // The "Voice model" priority does not depend on the local disk: what answers whether
    // the provider route exists is the provider's own snapshot. Without it, the
    // pipeline uses the local engine and the UI explains why (see the voice screen).
    modelTts: await modelTtsStatus(),
  }
}

/**
 * ids with the complete bytes on disk — it feeds the "not downloaded yet" warning of
 * `voice:hardware`. It is "downloaded" on purpose: Parakeet already counts as soon as the
 * package arrives, because the extraction is automatic.
 */
export async function downloadedModelIds(): Promise<string[]> {
  const ids: string[] = []
  for (const model of VOICE_MODELS) {
    if (await isModelDownloaded(model.id)) ids.push(model.id)
  }
  return ids
}
