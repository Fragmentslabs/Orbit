/**
 * The window of a piece audio track — where it starts and where it ends.
 *
 * The manifest may declare `end`, and then it rules. When it does NOT declare it, the two
 * sides that read the track disagreed on what the absence means: the render
 * understands "the whole file from the start" (in `motion-render-args`, without
 * `end` there is no `atrim`), while the timeline drew the bar up to the END OF THE
 * PIECE and kept the track lit until there — a 4 s narration appeared
 * running across 20 s of video.
 *
 * The real length is in the audio element itself (`el.duration`, which the
 * browser measures when the metadata arrives), so that is what closes the window when
 * the manifest stays silent. Both readings — drawing the bar and driving the sound —
 * come from here, on purpose: separated, they would disagree again.
 */

export type MotionTrackWindow = {
  start: number
  /** Second at which the track leaves; `null` when the manifest did not bound it. */
  end: number | null
}

/**
 * The second at which the track really ends, or `null` when there is no way to know
 * (neither `end` in the manifest nor loaded metadata). Without a window, the caller decides
 * what to do — today, the old guess: the whole piece.
 */
export function motionTrackEnd(
  track: MotionTrackWindow,
  duration: number | null | undefined,
): number | null {
  if (track.end !== null) return track.end
  if (duration === null || duration === undefined) return null
  if (!Number.isFinite(duration) || duration <= 0) return null
  return track.start + duration
}

/** Is the track inside its window at that instant? */
export function motionTrackIsLive(
  track: MotionTrackWindow,
  duration: number | null | undefined,
  at: number,
): boolean {
  if (at < track.start) return false
  const end = motionTrackEnd(track, duration)
  return end === null || at < end
}

/** From here on it is no longer drift, it is repositioning (dragging the ruler, cutting,
 *  switching track). Then the right thing is seek — waiting for the sound to catch up would be hearing it wrong. */
export const MOTION_AUDIO_SEEK_S = 0.4

/** Cap on the pace correction. 3% is inaudible in speech. */
export const MOTION_AUDIO_MAX_NUDGE = 0.03

/** Drift from which correcting the pace is worth it. It has to be LARGER than the step of the
 *  loop itself: `at` comes from the frame (1/30 s ≈ 33 ms), so the measured drift saws
 *  ±33 ms even with the sound stopped in the right place. A slack of 20 ms fell INSIDE
 *  that saw — the pace blinked on every frame, and every blink restarts the
 *  resample: that is the continuous click that was heard. */
export const MOTION_AUDIO_NUDGE_S = 0.15

/** Once correcting, it only stops when it gets close. It is hysteresis: without it the pace
 *  keeps turning on and off right at the threshold. */
export const MOTION_AUDIO_SETTLE_S = 0.06

/**
 * What PACE to put on the element so it reaches the playhead without cutting the sound.
 *
 * Every time difference used to be solved with `currentTime = …`. While the composition
 * scheme did not announce tracks, Chromium IGNORED that seek — and the choice
 * was harmless. When it started honoring it, every drift became buffer
 * discard: the sound stuttered and never settled, because on every re-sync the file was
 * dropped again.
 *
 * Small drift does not need a seek: a pace of up to 3% reaches the playhead in
 * a few seconds, with no click, no silence and no throwing away what has already been downloaded.
 * `drift` is how far the element is AHEAD of the playhead (positive = ahead,
 * so it has to slow down). `engaged` is the previous state of the element ITSELF —
 * is it already correcting? — and it is what gives the hysteresis: it leaves at a lower threshold
 * than it entered, so the pace does not oscillate right at the threshold (which was what made the
 * resample restart nonstop).
 */
export function motionAudioRate(drift: number, engaged: boolean): number {
  if (!Number.isFinite(drift)) return 1
  if (Math.abs(drift) <= (engaged ? MOTION_AUDIO_SETTLE_S : MOTION_AUDIO_NUDGE_S)) return 1
  const nudge = Math.max(-MOTION_AUDIO_MAX_NUDGE, Math.min(MOTION_AUDIO_MAX_NUDGE, -drift * 0.5))
  return 1 + nudge
}
