import type { MachineTier } from '../machine'

/**
 * Recording profiles of `browser_record`.
 *
 * A profile gathers the four decisions that go together — fps, x264 quality,
 * the quality of the JPEG the screencast emits and the resolution cap — into a name the
 * agent can choose without understanding codecs.
 *
 * The product rule, which is the reason this module exists:
 *
 * - `auto` (default) FOLLOWS THE MACHINE: strong records at 60 fps in high quality,
 *   weak records at 30 fps in low quality, so the take does not stutter;
 * - an EXPLICIT level always beats the tier. A weak machine does not stop anyone from
 *   asking for `max` — the video comes out at `max`, at most with repeated frames. Whoever
 *   warns that there was not enough breath is the result (`capturedFps`), not a "no".
 *
 * It lives in a module without Electron on purpose: it is the part that changes the most and the
 * one most worth having a test for.
 */

export type RecordQuality = 'auto' | 'low' | 'medium' | 'high' | 'max'

/** The profile already resolved — `auto` never gets here. */
export type FixedQuality = Exclude<RecordQuality, 'auto'>

export type RecordPreset = 'veryfast' | 'fast' | 'medium'

export interface RecordProfile {
  quality: FixedQuality
  /** Frames per second of the final video. */
  fps: number
  /** x264 CRF: smaller = better and bigger. */
  crf: number
  /** Quality (1-100) of the JPEG the CDP emits per frame. */
  jpegQuality: number
  /** Width cap of the captured frame, in device pixels. */
  maxWidth: number
  preset: RecordPreset
  /** The level came from the request, not from the machine's tier. */
  explicit: boolean
}

const PROFILES: Record<FixedQuality, Omit<RecordProfile, 'quality' | 'explicit'>> = {
  low: { fps: 30, crf: 26, jpegQuality: 65, maxWidth: 1280, preset: 'veryfast' },
  medium: { fps: 30, crf: 22, jpegQuality: 75, maxWidth: 1600, preset: 'veryfast' },
  // 60 fps is what makes a scroll and a hover look "for real"; from
  // here on the encode cost rises a lot, so only at high/max.
  high: { fps: 60, crf: 18, jpegQuality: 85, maxWidth: 1920, preset: 'fast' },
  max: { fps: 60, crf: 14, jpegQuality: 95, maxWidth: 2560, preset: 'medium' },
}

/** What a strong machine gets on its own. */
const AUTO_BY_TIER: Record<MachineTier, FixedQuality> = {
  weak: 'low',
  balanced: 'medium',
  strong: 'high',
}

export interface RecordProfileInput {
  quality?: RecordQuality
  /** Explicit fps override (beats the profile). */
  fps?: number
  /** Explicit CRF override (beats the profile). */
  crf?: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function resolveRecordProfile(input: RecordProfileInput, tier: MachineTier): RecordProfile {
  const wanted = input.quality ?? 'auto'
  const explicit = wanted !== 'auto'
  const quality = explicit ? (wanted as FixedQuality) : AUTO_BY_TIER[tier]
  const base = PROFILES[quality]
  return {
    ...base,
    quality,
    explicit,
    fps: clamp(Math.round(input.fps ?? base.fps), 10, 60),
    crf: clamp(Math.round(input.crf ?? base.crf), 12, 34),
  }
}

/** Short line for the log/result: "high (auto · strong machine) · 60 fps · crf 18". */
export function describeProfile(profile: RecordProfile, tier: MachineTier): string {
  const origin = profile.explicit ? 'requested' : `auto · machine ${tier}`
  return `${profile.quality} (${origin}) · ${profile.fps} fps · crf ${profile.crf}`
}
