/**
 * Animation helpers of the motion runtime — the primitives models already know from
 * Remotion, under `window.orbitMotion`:
 *
 *   interpolate(frame, [0, 20], [0, 1], { easing, extrapolateLeft, extrapolateRight })
 *   spring({ frame, fps, from, to, damping, mass, stiffness, delay })
 *   Easing.out(Easing.cubic), Easing.bezier(.2, .8, .2, 1), Easing.back(1.7)…
 *   sequence(frame, from, durationInFrames) → { active, frame, progress }
 *   audio.load() / audio.level(frame) / audio.bands(frame, n) — the REAL sound of the piece
 *
 * Without them a model writes `opacity = frame > 30 ? 1 : 0` (a hard cut) and a
 * waveform out of Math.sin — exactly what made a piece look amateur. With them the
 * eased entrance and the bars that follow the music are one line each.
 *
 * Everything here is a pure function of the frame (the golden rule of the runtime):
 * no state moves between seeks. The audio analysis is computed ONCE from the files
 * of audio.json (decoded by the page's own WebAudio) and then only read.
 *
 * It lives as page JS for the same reason as motion-timing: the runtime imports
 * nothing, and the tests execute THIS text. No backticks, no `${` and no backslash:
 * it is interpolated into the runtime's template.
 */
export const MOTION_HELPERS_SCRIPT = `
  // ------------------------------------------------------------- easing
  function orbitBezier(x1, y1, x2, y2) {
    function a(p1, p2) { return 1 - 3 * p2 + 3 * p1 }
    function b(p1, p2) { return 3 * p2 - 6 * p1 }
    function c(p1) { return 3 * p1 }
    function at(t, p1, p2) { return ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t }
    function slope(t, p1, p2) { return 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1) }
    function solve(x) {
      let t = x
      for (let i = 0; i < 8; i++) {
        const s = slope(t, x1, x2)
        if (Math.abs(s) < 1e-6) break
        const err = at(t, x1, x2) - x
        if (Math.abs(err) < 1e-7) return t
        t -= err / s
      }
      let lo = 0, hi = 1
      t = x
      for (let i = 0; i < 40; i++) {
        const v = at(t, x1, x2)
        if (Math.abs(v - x) < 1e-7) break
        if (v < x) lo = t; else hi = t
        t = (lo + hi) / 2
      }
      return t
    }
    return function (x) {
      if (x <= 0) return 0
      if (x >= 1) return 1
      return at(solve(x), y1, y2)
    }
  }

  const orbitEasing = {
    linear: function (t) { return t },
    quad: function (t) { return t * t },
    cubic: function (t) { return t * t * t },
    sin: function (t) { return 1 - Math.cos((t * Math.PI) / 2) },
    exp: function (t) { return t <= 0 ? 0 : Math.pow(2, 10 * (t - 1)) },
    circle: function (t) { return 1 - Math.sqrt(1 - t * t) },
    back: function (s) { if (s === undefined) s = 1.70158; return function (t) { return t * t * ((s + 1) * t - s) } },
    elastic: function (bounciness) {
      const p = (bounciness === undefined ? 1 : bounciness) * Math.PI
      return function (t) { return 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * p) }
    },
    bezier: orbitBezier,
    in: function (f) { return f },
    out: function (f) { return function (t) { return 1 - f(1 - t) } },
    inOut: function (f) { return function (t) { return t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2 } },
  }
  // The three everyone reaches for, ready to pass as { easing }.
  orbitEasing.easeIn = orbitEasing.cubic
  orbitEasing.easeOut = orbitEasing.out(orbitEasing.cubic)
  orbitEasing.easeInOut = orbitEasing.inOut(orbitEasing.cubic)

  // ------------------------------------------------------------- interpolate
  // Maps value from inputRange to outputRange (both increasing lists of the same size).
  // Unlike Remotion, both ends CLAMP by default: an entrance that keeps sliding past
  // its frame is the bug, not the feature. extrapolate: 'clamp' | 'extend' | 'identity'.
  function orbitInterpolate(value, inputRange, outputRange, options) {
    if (!inputRange || !outputRange || inputRange.length !== outputRange.length || inputRange.length < 2) {
      throw new Error('interpolate: inputRange and outputRange need the same length, at least 2')
    }
    for (let i = 1; i < inputRange.length; i++) {
      if (!(inputRange[i] > inputRange[i - 1])) throw new Error('interpolate: inputRange must be strictly increasing')
    }
    const o = options || {}
    const easing = o.easing || orbitEasing.linear
    const left = o.extrapolateLeft || o.extrapolate || 'clamp'
    const right = o.extrapolateRight || o.extrapolate || 'clamp'
    const n = inputRange.length
    let i = 1
    while (i < n - 1 && value > inputRange[i]) i++
    const x0 = inputRange[i - 1], x1 = inputRange[i]
    const y0 = outputRange[i - 1], y1 = outputRange[i]
    if (value < inputRange[0]) {
      if (left === 'identity') return value
      if (left === 'clamp') return outputRange[0]
    }
    if (value > inputRange[n - 1]) {
      if (right === 'identity') return value
      if (right === 'clamp') return outputRange[n - 1]
    }
    let t = (value - x0) / (x1 - x0)
    if (t >= 0 && t <= 1) t = easing(t)
    return y0 + (y1 - y0) * t
  }

  // ------------------------------------------------------------- spring
  // Closed-form damped spring (no state, no simulation): the same frame always gives the
  // same value. Defaults match Remotion (damping 10, mass 1, stiffness 100).
  function orbitSpring(o) {
    const fps = o.fps || 30
    const from = o.from === undefined ? 0 : o.from
    const to = o.to === undefined ? 1 : o.to
    const m = o.mass || 1
    const k = o.stiffness || 100
    const c = o.damping === undefined ? 10 : o.damping
    const t = (o.frame - (o.delay || 0)) / fps
    if (t <= 0) return from
    const w0 = Math.sqrt(k / m)
    const zeta = c / (2 * Math.sqrt(k * m))
    let x
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta)
      x = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    } else if (zeta === 1) {
      x = 1 - Math.exp(-w0 * t) * (1 + w0 * t)
    } else {
      const s = Math.sqrt(zeta * zeta - 1)
      const r1 = -w0 * (zeta - s), r2 = -w0 * (zeta + s)
      x = 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1)
    }
    if (o.overshootClamping && x > 1) x = 1
    return from + (to - from) * x
  }

  // ------------------------------------------------------------- sequence
  // Where a scene is at a given frame: active between from and from + duration, with its
  // LOCAL frame (0 at its start) and progress 0..1 — so each scene animates from 0.
  function orbitSequence(frame, from, durationInFrames) {
    const local = frame - from
    const dur = durationInFrames === undefined ? Infinity : durationInFrames
    const active = local >= 0 && local < dur
    const progress = dur === Infinity ? 0 : Math.min(1, Math.max(0, local / dur))
    return { active: active, frame: local, progress: progress }
  }

  // ------------------------------------------------------------- audio analysis
  // In-place radix-2 FFT (re, im of power-of-two length).
  function orbitFft(re, im) {
    const n = re.length
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      if (i < j) {
        let tr = re[i]; re[i] = re[j]; re[j] = tr
        tr = im[i]; im[i] = im[j]; im[j] = tr
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len
      const wr = Math.cos(ang), wi = Math.sin(ang)
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2
          const xr = re[b] * cr - im[b] * ci
          const xi = re[b] * ci + im[b] * cr
          re[b] = re[a] - xr; im[b] = im[a] - xi
          re[a] += xr; im[a] += xi
          const nr = cr * wr - ci * wi
          ci = cr * wi + ci * wr
          cr = nr
        }
      }
    }
  }

  // Per frame of the piece: loudness (RMS) and BANDS log-spaced frequency bands
  // (30 Hz to 12 kHz), both normalized to the loudest moment of the piece and
  // gently compressed (sqrt), so 1 is the peak and quiet passages still move.
  function orbitAnalyzeAudio(samples, rate, fps, frames, bands) {
    const B = bands || 32
    const N = 2048
    const per = rate / fps
    const level = new Float32Array(frames)
    const spec = new Float32Array(frames * B)
    const lo = 30, hi = Math.min(12000, rate / 2)
    const edges = []
    for (let b = 0; b <= B; b++) edges.push(Math.round((lo * Math.pow(hi / lo, b / B) * N) / rate))
    const re = new Float64Array(N), im = new Float64Array(N)
    const hann = new Float64Array(N)
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
    let maxLevel = 0, maxSpec = 0
    for (let f = 0; f < frames; f++) {
      const start = Math.floor(f * per)
      let sum = 0, count = 0
      for (let i = start; i < start + per && i < samples.length; i++) { sum += samples[i] * samples[i]; count++ }
      const rms = count ? Math.sqrt(sum / count) : 0
      level[f] = rms
      if (rms > maxLevel) maxLevel = rms
      const center = start + Math.floor(per / 2) - N / 2
      for (let i = 0; i < N; i++) {
        const s = center + i
        re[i] = s >= 0 && s < samples.length ? samples[s] * hann[i] : 0
        im[i] = 0
      }
      orbitFft(re, im)
      for (let b = 0; b < B; b++) {
        const from = Math.max(1, edges[b]), to = Math.max(from + 1, edges[b + 1])
        let m = 0
        for (let k = from; k < to && k < N / 2; k++) m += Math.sqrt(re[k] * re[k] + im[k] * im[k])
        m /= to - from
        spec[f * B + b] = m
        if (m > maxSpec) maxSpec = m
      }
    }
    for (let f = 0; f < frames; f++) level[f] = maxLevel ? Math.sqrt(level[f] / maxLevel) : 0
    for (let i = 0; i < spec.length; i++) spec[i] = maxSpec ? Math.sqrt(spec[i] / maxSpec) : 0
    return { level: level, spec: spec, bands: B, frames: frames }
  }

  // Reads an analysis: n bars at a frame (resampled from the stored bands).
  function orbitReadBands(data, frame, n) {
    const count = n || data.bands
    const out = new Array(count)
    const f = Math.max(0, Math.min(data.frames - 1, Math.round(frame)))
    if (!data.frames) { for (let i = 0; i < count; i++) out[i] = 0; return out }
    for (let i = 0; i < count; i++) {
      const a = Math.floor((i * data.bands) / count)
      const b = Math.max(a + 1, Math.floor(((i + 1) * data.bands) / count))
      let m = 0
      for (let k = a; k < b; k++) m = Math.max(m, data.spec[f * data.bands + k])
      out[i] = m
    }
    return out
  }

  // dB → linear gain, and the audio.json fields that decide a track's level.
  function orbitTrackGain(track) {
    if (typeof track.volume === 'number') return Math.max(0, track.volume)
    return typeof track.gain === 'number' ? Math.pow(10, track.gain / 20) : 1
  }

  // Places decoded tracks on the PIECE timeline (start, end, offset, loop, level), the
  // way the render mixes them. Fades, ducking and EQ are left out: this is for visuals.
  // tracks: [{ data: Float32Array, start, end, offset, loop, gain }] at one rate.
  function orbitMixTracks(tracks, rate, seconds) {
    const total = Math.max(1, Math.ceil(seconds * rate))
    const out = new Float32Array(total)
    for (const t of tracks) {
      const begin = Math.max(0, Math.round((t.start || 0) * rate))
      const stop = Math.min(total, typeof t.end === 'number' ? Math.round(t.end * rate) : total)
      const offset = Math.max(0, Math.round((t.offset || 0) * rate))
      const len = t.data.length
      if (!len) continue
      for (let i = begin; i < stop; i++) {
        let s = offset + (i - begin)
        if (s >= len) { if (!t.loop) break; s = s % len }
        out[i] += t.data[s] * t.gain
      }
    }
    return out
  }
`

/**
 * The page side that needs the runtime's state (fps, delayRender): loading the audio
 * of audio.json, analysing it once and exposing level/bands by frame. Interpolated
 * INSIDE the runtime, after delayRender and `resolved` exist.
 */
export const MOTION_AUDIO_LOADER_SCRIPT = `
  const AUDIO_RATE = 22050
  const audioCache = {}
  const audioPending = {}
  function audioKey(which) { return which ? String(which) : '*' }
  function rootUrl(file) { return new URL('/' + String(file).replace(/^[.][/]/, '').replace(/^[/]+/, ''), location.href).href }
  async function decodeFile(file) {
    const res = await fetch(rootUrl(file))
    if (!res.ok) throw new Error('audio file not found: ' + file)
    const bytes = await res.arrayBuffer()
    const ctx = new OfflineAudioContext(1, 1, AUDIO_RATE)
    const buffer = await ctx.decodeAudioData(bytes)
    const ch = buffer.numberOfChannels
    const data = new Float32Array(buffer.length)
    for (let c = 0; c < ch; c++) {
      const src = buffer.getChannelData(c)
      for (let i = 0; i < data.length; i++) data[i] += src[i] / ch
    }
    return data
  }
  async function analyse(which) {
    let tracks = []
    const manifest = await fetch(rootUrl('audio.json')).then(function (r) { return r.ok ? r.json() : null }).catch(function () { return null })
    const list = manifest ? (Array.isArray(manifest) ? manifest : manifest.tracks || []) : []
    if (list.length) tracks = list.filter(function (t) { return t && t.file && (!which || t.file === which || t.name === which) })
    else if (which) tracks = [{ file: which }]
    if (!tracks.length) throw new Error(which ? 'audio "' + which + '" is not in audio.json' : 'no audio.json tracks to analyse')
    const decoded = {}
    for (const t of tracks) if (!decoded[t.file]) decoded[t.file] = await decodeFile(t.file)
    const fps = resolved.fps || FPS
    let seconds = resolved.durationInFrames ? resolved.durationInFrames / fps : 0
    if (!seconds) {
      for (const t of tracks) seconds = Math.max(seconds, typeof t.end === 'number' ? t.end : (t.start || 0) + decoded[t.file].length / AUDIO_RATE - (t.offset || 0))
    }
    const mix = orbitMixTracks(tracks.map(function (t) {
      return { data: decoded[t.file], start: t.start, end: t.end, offset: t.offset, loop: t.loop, gain: orbitTrackGain(t) }
    }), AUDIO_RATE, seconds)
    return orbitAnalyzeAudio(mix, AUDIO_RATE, fps, Math.max(1, Math.ceil(seconds * fps)), 32)
  }
  const audioApi = {
    // Start analysing (the mix of audio.json, or one track by file/name). Seeks wait for
    // it, so call it at the top of the composition script.
    load: function (which) {
      const key = audioKey(which)
      if (audioCache[key]) return Promise.resolve(audioCache[key])
      if (audioPending[key]) return audioPending[key]
      const handle = delayRender()
      audioPending[key] = analyse(which).then(function (data) {
        audioCache[key] = data
        return data
      }, function (err) {
        noteScriptError('orbitMotion.audio: ' + (err && err.message ? err.message : String(err)))
        audioCache[key] = { level: new Float32Array(0), spec: new Float32Array(0), bands: 32, frames: 0 }
        return audioCache[key]
      }).finally(function () { continueRender(handle) })
      return audioPending[key]
    },
    // Loudness at a frame, 0..1 (1 = loudest moment of the piece).
    level: function (frame, which) {
      const data = audioCache[audioKey(which)]
      if (!data) { audioApi.load(which); return 0 }
      if (!data.frames) return 0
      return data.level[Math.max(0, Math.min(data.frames - 1, Math.round(frame)))]
    },
    // n frequency bars at a frame, low to high, each 0..1 — a real spectrum/waveform.
    bands: function (frame, n, which) {
      const data = audioCache[audioKey(which)]
      if (!data) { audioApi.load(which); return new Array(n || 32).fill(0) }
      return orbitReadBands(data, frame, n)
    },
  }
`
