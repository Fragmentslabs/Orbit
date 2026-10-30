import type { VoiceEngineId, VoiceHardwareInfo } from "@shared/voice"
import { detectMachine } from "../machine"
import { STT_MODELS } from "./stt"
import { modelInfo } from "./manifest"
import { preferredWhisperModelId } from "./catalog"
import { tNow } from '../i18n'

/**
 * Machine detection and recommendation of the transcription engine.
 *
 * The rule comes from the voice laboratory measurements:
 *  - Parakeet TDT 0.6B v3 through `sherpa-onnx` is the preferred one (binaries ready
 *    for darwin/win/linux x64 and arm64, N-API, CPU only). In exchange, the process
 *    grows ~1.3 GB with the model loaded;
 *  - so it demands real memory: on an 8 GB machine the RAM cost
 *    blows up and a smaller whisper is worth it (the small one, or base below 8 GB);
 *  - an arch outside x64/arm64 (or a system with no sherpa-onnx binary) does not run
 *    Parakeet at all — there the recommendation is whisper.
 *
 * `reason` and `warnings` ALWAYS come out filled: the voice screen shows both,
 * and a recommendation without a justification becomes a black box for whoever uses it.
 */

/** preferred Parakeet id in the STT catalog (the concrete one comes from STT_MODELS). */
export const PARAKEET_MODEL_ID = "parakeet-tdt-0.6b-v3"

/**
 * Below this, Parakeet (1.3 GB of RSS) weighs too much on the machine. It is not 16:
 * `os.totalmem()` discounts what the firmware and the integrated GPU reserve, and a
 * 16 GB machine shows up with 15.3 GB — precisely those with plenty of
 * room were left out. 12 separates the 16 GB ones from the 8 GB ones with margin.
 */
const MIN_MEMORY_GB = 12

/** RAM Parakeet occupies with the model loaded (measured in the laboratory). */
const PARAKEET_RAM_GB = 1.3

export interface HardwareOptions {
  /** ids of models already DOWNLOADED (complete bytes on disk) — only for the "not downloaded yet" warning. */
  downloadedIds?: string[]
}

/** Does the system have a sherpa-onnx binary on this platform? */
function sherpaSupported(platform: string, arch: string): boolean {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return false
  return arch === "arm64" || arch === "x64"
}

/**
 * catalog id for the requested engine: uses the known id when it exists in
 * STT_MODELS and falls back to the smallest model of that engine when it does not (the catalog
 * belongs to the other worker — the recommendation never points to an invented id).
 */
function pickModel(engine: VoiceEngineId, preferredId: string): string {
  if (STT_MODELS.some((model) => model.id === preferredId && model.engine === engine)) return preferredId
  const same = STT_MODELS.filter((model) => model.engine === engine)
  if (same.length === 0) return preferredId
  return same.reduce((smallest, model) => (model.bytes < smallest.bytes ? model : smallest)).id
}

/** Size in "UI" MB (decimal, the way HuggingFace and the stores advertise it). */
function mb(bytes: number): number {
  return Math.round(bytes / 1e6)
}

export function detectHardware(options: HardwareOptions = {}): VoiceHardwareInfo {
  // Machine numbers come from the common detector (`lib/machine.ts`): video
  // recording uses the same ones, and two different calculations for "how many GB this
  // machine has" would end up diverging.
  const { platform, arch, totalMemGb, cpus } = detectMachine()
  const downloaded = new Set(options.downloadedIds ?? [])
  const warnings: string[] = []

  const runsParakeet = sherpaSupported(platform, arch)
  const enoughMemory = totalMemGb >= MIN_MEMORY_GB
  const recommendedEngine: VoiceEngineId = runsParakeet && enoughMemory ? "parakeet" : "whisper"
  // The model ALWAYS belongs to the recommended engine: asking for the Parakeet id for
  // whisper returned Parakeet itself (it exists in the catalog), and the screen said
  // "whisper.cpp with Parakeet".
  const preferredModel = recommendedEngine === "parakeet" ? PARAKEET_MODEL_ID : preferredWhisperModelId(totalMemGb)
  const recommendedModel = pickModel(recommendedEngine, preferredModel)

  let reason: string
  if (!runsParakeet) {
    reason = tNow('voice.hardware.sherpaMissing', { platform, arch })
  } else if (!enoughMemory) {
    reason = tNow('voice.hardware.lowRam', { gb: totalMemGb, need: PARAKEET_RAM_GB })
  } else {
    reason = tNow('voice.hardware.parakeetReady', { platform, arch, gb: totalMemGb, need: PARAKEET_RAM_GB })
  }

  if (runsParakeet && !enoughMemory) {
    warnings.push(tNow('voice.hardware.lowMemoryWarning', { gb: totalMemGb, need: PARAKEET_RAM_GB }))
  }
  if (cpus < 4) {
    warnings.push(tNow('voice.hardware.fewCpus', { cpus }))
  }
  if (platform === "darwin" && arch === "x64") {
    warnings.push(tNow('voice.hardware.macIntel'))
  }
  if (platform === "win32") {
    warnings.push(tNow('voice.hardware.windowsPreview'))
  }
  if (platform === "darwin") {
    warnings.push(tNow('voice.hardware.macos26'))
  }
  if (platform === "linux") {
    warnings.push(tNow('voice.hardware.linuxNoEngine'))
  }

  const info = modelInfo(recommendedModel)
  if (info && !downloaded.has(recommendedModel)) {
    warnings.push(tNow('voice.hardware.notDownloaded', { model: recommendedModel, mb: mb(info.bytes) }))
  }

  return { platform, arch, totalMemGb, cpus, recommendedEngine, recommendedModel, reason, warnings }
}
