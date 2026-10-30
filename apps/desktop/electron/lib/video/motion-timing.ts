/**
 * The TIME of media inside a composition: at what point of the file a
 * `<video>` or a GIF is at a given instant of the PIECE.
 *
 * It lives here, in page JS, because the runtime runs in the window and imports
 * nothing — and because only this way do the tests execute the SAME function the page uses,
 * without a DOM. The golden rule is the rest of the runtime's: the position is a pure function of
 * the instant `t`. No media moves by itself.
 *
 * Attributes the composition may put on the element (all optional, in seconds):
 *   - `data-start`: the instant of the PIECE at which the video/GIF starts playing. Before
 *     that it stays frozen on the first frame;
 *   - `data-in`: from what point of the FILE it starts (a cut at the beginning);
 *   - `data-end`: the instant of the PIECE at which it stops, frozen on the last frame;
 *   - `data-loop="false"` on a GIF: plays once and stays on the last frame (the default
 *     is to repeat, like every GIF);
 *   - `data-gain` (dB) and `data-audio="false"` on a video: level of its sound in the
 *     mix, or out of it (the HTML `muted` attribute also takes it out).
 * Without any of them the behavior is the previous one: the file plays from frame 0.
 *
 * No backticks, no `${` and no backslash: it is interpolated into the runtime's template.
 */
export const MOTION_TIMING_SCRIPT = `
  // Position, in seconds OF THE FILE, of a video at instant t of the piece.
  // m = { start, in, end, loop, duration } (end and duration may be missing).
  function orbitVideoTime(t, m) {
    const start = m.start || 0
    const offset = m.in || 0
    let local = t - start
    if (local < 0) local = 0
    if (typeof m.end === 'number' && m.end > start) local = Math.min(local, m.end - start)
    const at = offset + local
    if (!m.duration) return at
    if (m.loop) return at % m.duration
    return Math.min(at, m.duration - 0.001)
  }

  // Frame index of a GIF at local instant t (the data-start already discounted).
  // durations = seconds of each frame; loop = repeats (the default of every GIF).
  function orbitGifFrame(t, durations, loop) {
    const n = durations.length
    if (n === 0 || t <= 0) return 0
    let total = 0
    for (let i = 0; i < n; i++) total += durations[i]
    if (total <= 0) return 0
    const local = loop ? t % total : Math.min(t, total - 0.000001)
    let acc = 0
    for (let i = 0; i < n; i++) {
      acc += durations[i]
      if (local < acc) return i
    }
    return n - 1
  }

  // Duration of a GIF frame. Browsers treat a delay shorter than 20 ms
  // (0 included) as 100 ms — which is what a GIF "without delay" has always shown.
  function orbitGifDelay(seconds) {
    return typeof seconds === 'number' && isFinite(seconds) && seconds >= 0.02 ? seconds : 0.1
  }
`
