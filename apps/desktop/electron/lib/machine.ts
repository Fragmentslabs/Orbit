import os from 'node:os'

/**
 * Machine capacity, in a single place.
 *
 * The detection was born inside voice (`voice/hardware.ts`), which decided the transcription engine
 * by counting RAM. It is useful for any feature that needs to
 * answer "can it go max?" — today `browser_record`'s recording profile,
 * tomorrow the motion render.
 *
 * What matters here is what weighs on media work: cores (compositor +
 * x264) and RAM (frame queue). The scoring is coarse ON PURPOSE — it is not a
 * benchmark, it is a step. Measuring for real (running a sample and timing it)
 * would cost seconds on every call and would give different answers depending on what
 * was open on the machine.
 *
 * Golden rule for whoever consumes it: the tier is a SUGGESTION for the default. An explicit
 * request from the user (or the agent) always wins — a weak machine does not prevent
 * recording in high quality, it only warns that it may run short of breath.
 */

export type MachineTier = 'weak' | 'balanced' | 'strong'

export interface MachineInfo {
  platform: string
  arch: string
  cpus: number
  totalMemGb: number
  /** Raw score — only for diagnosis; what decides is `tier`. */
  score: number
  tier: MachineTier
}

/** From here on the machine handles 60 fps at high resolution without stuttering. */
const STRONG_SCORE = 9

/** Below this there is little left to capture and encode at the same time. */
const BALANCED_SCORE = 3

export function machineTier(score: number): MachineTier {
  if (score >= STRONG_SCORE) return 'strong'
  if (score >= BALANCED_SCORE) return 'balanced'
  return 'weak'
}

/**
 * - cores: each core above 4 is worth 1 (the first 4 are the minimum for the
 *   app to run; what is left is what the compositor and x264 can use);
 * - RAM: 8 GB = 1, 16 GB = 3, 32 GB+ = 5 (it is where the frame queue lives);
 * - Apple Silicon: +3, because the encode has VideoToolbox alongside and the
 *   compositor is much more efficient than a x64 one of the same range.
 *
 * The RAM ranges are 7/12/30 and not 8/16/32 on purpose: `os.totalmem()`
 * deducts what the firmware and the integrated GPU reserve, so a 16 GB machine
 * presents itself with ~15.3 GB. With the cut at 16, it would fall into the low
 * step — exactly those with slack to spare. (The same trap that voice already
 * documents in `MIN_MEMORY_GB`.)
 */
export function scoreMachine(input: {
  cpus: number
  totalMemGb: number
  platform: string
  arch: string
}): number {
  const cores = Math.max(0, input.cpus - 4)
  const ram = input.totalMemGb >= 30 ? 5 : input.totalMemGb >= 12 ? 3 : input.totalMemGb >= 7 ? 1 : 0
  const apple = input.platform === 'darwin' && input.arch === 'arm64' ? 3 : 0
  return cores + ram + apple
}

export function detectMachine(): MachineInfo {
  const platform = process.platform
  const arch = os.arch()
  const cpus = Math.max(1, os.cpus().length || 1)
  // Same account as voice: `totalmem()` deducts what the firmware reserves, and a
  // 16 GB machine shows up with ~15.3 GB.
  const totalMemGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const score = scoreMachine({ cpus, totalMemGb, platform, arch })
  return { platform, arch, cpus, totalMemGb, score, tier: machineTier(score) }
}
