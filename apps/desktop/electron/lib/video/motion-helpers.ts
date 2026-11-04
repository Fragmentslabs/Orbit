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

  // ------------------------------------------------------------- scenes
  // The piece as a list of scenes with a DURATION each (seconds); the start of each one comes
  // from the sum, so cutting 10 s from the middle is changing one number — not retyping every
  // time after it. dur: seconds · overlap: seconds the scene starts BEFORE the previous one
  // ends (a crossfade; per scene, or opts.overlap for all) · gap: seconds of nothing before it.
  //   const S = orbitScenes([{ name: "intro", dur: 4 }, { name: "verse", dur: 20, overlap: 0.5 }])
  //   S.verse.start · S.total · S.at(t) · S.local("verse", t) → { active, t, progress }
  function orbitScenes(list, opts) {
    const o = opts || {}
    if (!Array.isArray(list) || !list.length) throw new Error('scenes: pass a list like [{ name: "intro", dur: 4 }, ...] (dur in seconds)')
    const reserved = ['list', 'total', 'get', 'at', 'local']
    const round = function (x) { return Math.round(x * 1000000) / 1000000 }
    const items = []
    const byName = {}
    let cursor = 0
    for (let i = 0; i < list.length; i++) {
      const sc = list[i] || {}
      const label = 'scene ' + (i + 1) + (sc.name ? ' "' + sc.name + '"' : '')
      if (typeof sc.name !== 'string' || !sc.name) throw new Error('scenes: ' + label + ' needs a name')
      if (byName[sc.name]) throw new Error('scenes: two scenes are called "' + sc.name + '"')
      const dur = Number(sc.dur)
      if (!isFinite(dur) || dur <= 0) throw new Error('scenes: ' + label + ' needs dur > 0 (seconds)')
      const gap = Math.max(0, Number(sc.gap) || 0)
      const wanted = sc.overlap !== undefined ? Number(sc.overlap) : (o.overlap || 0)
      const overlap = i === 0 ? 0 : Math.max(0, Math.min(wanted || 0, dur, items[i - 1].dur))
      const start = Math.max(0, cursor + gap - overlap)
      const item = { name: sc.name, start: round(start), end: round(start + dur), dur: dur }
      items.push(item)
      byName[sc.name] = item
      cursor = start + dur
    }
    const result = { list: items, total: round(cursor) }
    result.get = function (name) {
      const found = byName[name]
      if (!found) throw new Error('scenes: no scene "' + name + '" — they are ' + items.map(function (x) { return x.name }).join(', '))
      return found
    }
    // The scene on screen at t; during an overlap, the one that is coming in.
    result.at = function (t) {
      let found = null
      for (const it of items) if (t >= it.start && t < it.end) found = it
      return found
    }
    result.local = function (name, t) {
      const it = result.get(name)
      const local = t - it.start
      return { active: local >= 0 && local < it.dur, t: local, progress: Math.min(1, Math.max(0, local / it.dur)) }
    }
    for (const it of items) if (reserved.indexOf(it.name) < 0) result[it.name] = it
    return result
  }

  // ------------------------------------------------------------- random
  // The same seed always gives the same number in [0, 1): the deterministic replacement of
  // Math.random (a pure function of the seed, so frame N draws the same in every band and render).
  // The seed is any string or number: random('p' + i + ':x') for the x of particle i.
  function orbitRandom(seed) {
    const text = String(seed)
    let h = 1779033703 ^ text.length
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
      h = (h << 13) | (h >>> 19)
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }

  // ------------------------------------------------------------- camera
  // A flat world seen through a virtual camera: pan (x, y in WORLD pixels = the point at the
  // centre of the frame), zoom (1 = natural size) and rot (degrees). Depth is FAKED: a layer with
  // depth d moves 1/d as far and zooms zoom^(1/d) — parallax with no 3D. All of it is a pure
  // function of time, so a frame is the same in the tab, in motion_frame and in the render.
  const ORBIT_CAMERA_STYLES = ['ease', 'linear', 'push', 'pull', 'slingshot', 'whip']

  // How far along (0..1, it may leave that range on purpose) a move is at progress p.
  //   ease      in-out cubic: the calm default
  //   push      accelerates toward the lens (a zoom-in that lunges)
  //   pull      starts fast and settles (a pull-back, a settle)
  //   slingshot winds up the OTHER way (back, a fraction of the travel), then launches and overshoots
  //   whip      holds, snaps across and stops short: a fast pan
  function orbitCameraProgress(style, p, o) {
    const q = Math.min(1, Math.max(0, p))
    const opt = o || {}
    if (style === 'linear') return q
    if (style === 'push') return Math.pow(q, 2.2)
    if (style === 'pull') return 1 - Math.pow(1 - q, 2.2)
    if (style === 'whip') return orbitBezier(0.8, 0, 0.1, 1)(q)
    if (style === 'slingshot') {
      const back = opt.back === undefined ? 0.12 : opt.back
      const over = opt.overshoot === undefined ? 1.2 : opt.overshoot
      const wind = 0.3
      if (q < wind) { const u = q / wind; return -back * u * u * (3 - 2 * u) }
      const r = (q - wind) / (1 - wind)
      const out = 1 + (over + 1) * Math.pow(r - 1, 3) + over * Math.pow(r - 1, 2)
      return -back + (1 + back) * out
    }
    return q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2
  }

  // The list of moves with every FROM resolved: a move only says what changes; the rest stays
  // where the previous move left it. Moves are in SECONDS and may not overlap.
  function orbitCameraPlan(initial, list) {
    const sorted = list.slice().sort(function (a, b) { return a.at - b.at })
    const out = []
    let cur = { x: initial.x, y: initial.y, zoom: initial.zoom, rot: initial.rot }
    let free = 0
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i]
      const label = 'camera move ' + (i + 1) + ' (at ' + m.at + ' s)'
      const at = Number(m.at)
      const dur = Number(m.dur === undefined ? 0.6 : m.dur)
      if (!isFinite(at) || at < 0) throw new Error('camera: ' + label + ' needs at >= 0 (seconds)')
      if (!isFinite(dur) || dur <= 0) throw new Error('camera: ' + label + ' needs dur > 0 (seconds)')
      const style = m.style || 'ease'
      if (ORBIT_CAMERA_STYLES.indexOf(style) < 0) throw new Error('camera: style "' + style + '" does not exist — use ' + ORBIT_CAMERA_STYLES.join(', '))
      if (at < free - 1e-9) throw new Error('camera: ' + label + ' starts before the previous move ends (' + Math.round(free * 1000) / 1000 + ' s) — moves cannot overlap')
      const to = { x: cur.x, y: cur.y, zoom: cur.zoom, rot: cur.rot }
      const keys = ['x', 'y', 'zoom', 'rot']
      for (let k = 0; k < keys.length; k++) {
        const v = m.to ? m.to[keys[k]] : undefined
        if (v === undefined) continue
        if (!isFinite(Number(v))) throw new Error('camera: ' + label + ' has a to.' + keys[k] + ' that is not a number')
        to[keys[k]] = Number(v)
      }
      if (!(to.zoom > 0)) throw new Error('camera: ' + label + ' needs zoom > 0')
      out.push({ at: at, dur: dur, style: style, from: cur, to: to, back: m.back, overshoot: m.overshoot })
      cur = to
      free = at + dur
    }
    return out
  }

  // Where the camera is at time t. Zoom is interpolated GEOMETRICALLY (equal ratio per frame):
  // that is what a real zoom feels like; a linear zoom seems to crawl and then rush.
  function orbitCameraState(initial, plan, t) {
    let m = null
    for (let i = 0; i < plan.length; i++) { if (plan[i].at <= t) m = plan[i]; else break }
    if (!m) return { x: initial.x, y: initial.y, zoom: initial.zoom, rot: initial.rot }
    if (t >= m.at + m.dur) return { x: m.to.x, y: m.to.y, zoom: m.to.zoom, rot: m.to.rot }
    const f = orbitCameraProgress(m.style, (t - m.at) / m.dur, m)
    return {
      x: m.from.x + (m.to.x - m.from.x) * f,
      y: m.from.y + (m.to.y - m.from.y) * f,
      zoom: m.from.zoom * Math.pow(m.to.zoom / m.from.zoom, f),
      rot: m.from.rot + (m.to.rot - m.from.rot) * f,
    }
  }

  // A camera shake: smooth random offsets (not white noise), dying out by the end. Additive.
  // amp is in world pixels, rot in degrees, freq in "new directions per second".
  function orbitCameraShake(shakes, t) {
    let x = 0, y = 0, rot = 0
    for (let k = 0; k < shakes.length; k++) {
      const s = shakes[k]
      const local = t - s.at
      if (local < 0 || local > s.dur) continue
      const decay = Math.pow(1 - local / s.dur, 2)
      const n = local * s.freq
      const i = Math.floor(n)
      const fr = n - i
      const sm = fr * fr * (3 - 2 * fr)
      const pick = function (axis) {
        const a = orbitRandom(s.seed + ':' + axis + ':' + i)
        const b = orbitRandom(s.seed + ':' + axis + ':' + (i + 1))
        return (a + (b - a) * sm - 0.5) * 2
      }
      x += pick('x') * s.amp * decay
      y += pick('y') * s.amp * decay
      rot += pick('r') * s.rot * decay
    }
    return { x: x, y: y, rot: rot }
  }

  // The CSS matrix [a, b, c, d, e, f] that puts a layer of the given depth where the camera sees
  // it: translate(w/2, h/2) rotate(rot) scale(zoom) translate(-x, -y), with depth applied.
  // The layer must have transform-origin 0 0.
  function orbitCameraMatrix(st, depth, w, h) {
    const d = depth > 0 ? depth : 1
    const cx = w / 2 + (st.x - w / 2) / d
    const cy = h / 2 + (st.y - h / 2) / d
    const z = Math.pow(st.zoom, 1 / d)
    const ang = (st.rot * Math.PI) / 180
    const a = Math.cos(ang) * z, b = Math.sin(ang) * z
    const c = -b, dd = a
    return [a, b, c, dd, w / 2 - (a * cx + c * cy), h / 2 - (b * cx + dd * cy)]
  }

  // The camera that frames a rectangle of the world ({ x, y, w, h }). fit "contain" (default)
  // keeps all of it in view; "cover" fills the frame with it — the zoom-through, where the object
  // BECOMES the background. padding in px (contain), scale multiplies the final zoom.
  function orbitCameraFit(rect, viewW, viewH, o) {
    const opt = o || {}
    const pad = opt.padding || 0
    const contain = Math.min(Math.max(1, viewW - 2 * pad) / rect.w, Math.max(1, viewH - 2 * pad) / rect.h)
    const cover = Math.max(viewW / rect.w, viewH / rect.h)
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom: (opt.fit === 'cover' ? cover : contain) * (opt.scale || 1) }
  }

  // ------------------------------------------------------------- text effects
  // orbitMotion.text('#title', { by: 'chars' | 'words' | 'lines', style: 'rise', at: 0.4 }) splits the text
  // of an element into units and reveals them one after the other. Everything here is pure: where a unit
  // is at time t depends only on t. The splitting and the styles are what the page script applies.
  const ORBIT_TEXT_STYLES = ['fade', 'rise', 'drop', 'pop', 'mask', 'blur', 'slide', 'typewriter']
  const ORBIT_TEXT_BY = ['chars', 'words', 'lines']
  const ORBIT_TEXT_ORDERS = ['forward', 'reverse', 'center', 'random']

  // The words of a text, each with its characters (a character is a code point: an emoji is ONE).
  // Whitespace of any kind separates words and is not kept: the page puts a plain space between them.
  function orbitWords(text) {
    const words = []
    let cur = ''
    for (const ch of String(text)) {
      const code = ch.codePointAt(0)
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        if (cur) { words.push(cur); cur = '' }
      } else cur += ch
    }
    if (cur) words.push(cur)
    return words.map(function (w) { return { text: w, chars: Array.from(w) } })
  }

  // The start time of each of n units. The rank is the position in the reveal order (forward, reverse,
  // from the centre outward, or a fixed shuffle): start = at + rank * stagger.
  function orbitTextStarts(n, o) {
    const at = o.at || 0
    const stagger = o.stagger === undefined ? 0.05 : o.stagger
    const order = o.order || 'forward'
    const idx = []
    for (let i = 0; i < n; i++) idx.push(i)
    let ranked
    if (order === 'reverse') ranked = idx.slice().reverse()
    else if (order === 'center') {
      const mid = (n - 1) / 2
      ranked = idx.slice().sort(function (a, b) { return Math.abs(a - mid) - Math.abs(b - mid) || a - b })
    } else if (order === 'random') {
      const key = function (i) { return orbitRandom(String(o.seed === undefined ? 'text' : o.seed) + ':' + i) }
      ranked = idx.slice().sort(function (a, b) { return key(a) - key(b) })
    } else ranked = idx
    const starts = new Array(n)
    for (let r = 0; r < n; r++) starts[ranked[r]] = at + r * stagger
    return starts
  }

  // Easing of the reveal by name; every style has its own default.
  function orbitTextEase(name) {
    if (name === 'linear') return orbitEasing.linear
    if (name === 'back') return orbitEasing.out(orbitEasing.back(1.8))
    if (name === 'inOut') return orbitEasing.easeInOut
    return orbitEasing.easeOut
  }
  const ORBIT_TEXT_DEFAULT_EASE = { fade: 'out', rise: 'out', drop: 'out', pop: 'back', mask: 'out', blur: 'out', slide: 'out', typewriter: 'linear' }

  // The look of a unit at progress p (0 = hidden, 1 = in place). Distances are in em (the font size of the
  // text), blur in px, the mask offset in % of the unit's own height. p = 1 is ALWAYS the untouched text.
  function orbitTextState(style, p, o) {
    const opt = o || {}
    const q = Math.min(1, Math.max(0, p))
    const e = orbitTextEase(opt.ease || ORBIT_TEXT_DEFAULT_EASE[style])(q)
    const dist = opt.distance === undefined ? 0.6 : opt.distance
    const fade = Math.min(1, q * 1.6)
    const out = { opacity: 1, x: 0, y: 0, scale: 1, blur: 0, mask: 0 }
    if (style === 'fade') out.opacity = e
    else if (style === 'rise') { out.opacity = fade; out.y = (1 - e) * dist }
    else if (style === 'drop') { out.opacity = fade; out.y = -(1 - e) * dist }
    else if (style === 'pop') { out.opacity = q > 0 ? 1 : 0; out.scale = Math.max(0, e) }
    else if (style === 'mask') { out.opacity = q > 0 ? 1 : 0; out.mask = (1 - e) * 110 }
    else if (style === 'blur') { out.opacity = fade; out.blur = (1 - q) * (opt.blur === undefined ? 14 : opt.blur) }
    else if (style === 'slide') { out.opacity = fade; out.x = (opt.direction === 'right' ? -1 : 1) * (1 - e) * dist * 2 }
    else if (style === 'typewriter') out.opacity = q > 0 ? 1 : 0
    else throw new Error('text: style "' + style + '" does not exist — use ' + ORBIT_TEXT_STYLES.join(', '))
    // No negative zero: p = 1 must be exactly the untouched text.
    out.x = out.x || 0
    out.y = out.y || 0
    return out
  }

  // ------------------------------------------------------------- fit text
  // The largest whole font size in [min, max] for which fits(size) holds (fits is monotone: if
  // a size fits, every smaller one does). null when not even min fits.
  function orbitFitSize(fits, min, max) {
    let lo = Math.ceil(min), hi = Math.floor(max), best = null
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (fits(mid)) { best = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return best
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

  // ------------------------------------------------------------- spoken words
  // A word as it is compared: no accents, no case, no punctuation. "Humilde," == "humilde".
  const ORBIT_ACCENTS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g')
  function orbitNormWord(text) {
    const plain = String(text).normalize('NFD').replace(ORBIT_ACCENTS, '').toLowerCase()
    let out = ''
    for (const c of plain) if ((c >= '0' && c <= '9') || c.toLowerCase() !== c.toUpperCase() || c.charCodeAt(0) > 0x2e7f) out += c
    return out
  }

  // The words of one track of audio.json (the sidecar is { words: [{ text, startMs, endMs }] },
  // in seconds OF THE FILE) moved to the PIECE clock: track.start + (word - track.offset). Words
  // outside what the track plays (before its offset, after its end) are dropped.
  function orbitTrackWords(track, sidecar) {
    const list = sidecar && Array.isArray(sidecar.words) ? sidecar.words : []
    const start = track.start || 0
    const offset = track.offset || 0
    const out = []
    for (const w of list) {
      const from = w.startMs / 1000, to = w.endMs / 1000
      if (to <= offset) continue
      const s = start + Math.max(from, offset) - offset
      const e = start + to - offset
      if (typeof track.end === 'number' && s >= track.end) continue
      out.push({ text: String(w.text).trim(), start: s, end: typeof track.end === 'number' ? Math.min(e, track.end) : e, track: track.name || track.file, file: track.file })
    }
    return out
  }

  // Words → lines: a line closes at a pause, at punctuation or after maxWords. The same rule
  // that cut the caption lines audio_generate prints, so both agree.
  function orbitWordLines(words, opts) {
    const o = opts || {}
    const maxWords = o.maxWords || 7
    const pause = typeof o.pause === 'number' ? o.pause : 0.35
    const lines = []
    let cur = []
    function close() {
      if (!cur.length) return
      lines.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map(function (w) { return w.text }).join(' '), words: cur })
      cur = []
    }
    for (const w of words) {
      const last = cur[cur.length - 1]
      if (last && w.start - last.end >= pause) close()
      cur.push(w)
      if (/[.!?;:,]$/.test(w.text) || cur.length >= maxWords) close()
    }
    close()
    return lines
  }

  // Index of the word being spoken at piece time t (the last one that started), or -1 before the first.
  function orbitWordAt(words, t) {
    let at = -1
    for (let i = 0; i < words.length; i++) { if (words[i].start <= t) at = i; else break }
    return at
  }

  // Start time (piece seconds) of the first word equal to text at or after "after" (default 0),
  // or -1. A phrase ("quase silencio") finds the start of its first word when the rest follows.
  function orbitFindWord(words, text, after) {
    const target = String(text).split(' ').map(orbitNormWord).filter(Boolean)
    if (!target.length) return -1
    const from = typeof after === 'number' ? after : 0
    for (let i = 0; i + target.length <= words.length; i++) {
      if (words[i].start < from) continue
      let ok = true
      for (let k = 0; k < target.length; k++) if (orbitNormWord(words[i + k].text) !== target[k]) { ok = false; break }
      if (ok) return words[i].start
    }
    return -1
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
  async function readManifestTracks() {
    const manifest = await fetch(rootUrl('audio.json')).then(function (r) { return r.ok ? r.json() : null }).catch(function () { return null })
    return manifest ? (Array.isArray(manifest) ? manifest : manifest.tracks || []) : []
  }
  // The words of every track that has a sidecar (file + '.words.json'), on the piece clock.
  // Silent when there is none: a track without words is a track without words, not an error.
  let wordsAll = null
  let wordsPending = null
  function ensureWords() {
    if (wordsAll) return Promise.resolve(wordsAll)
    if (wordsPending) return wordsPending
    const handle = delayRender()
    wordsPending = readManifestTracks().then(async function (list) {
      const out = []
      for (const t of list) {
        if (!t || !t.file) continue
        const sidecar = await fetch(rootUrl(t.file + '.words.json')).then(function (r) { return r.ok ? r.json() : null }).catch(function () { return null })
        if (sidecar) for (const w of orbitTrackWords(t, sidecar)) out.push(w)
      }
      return out
    }).catch(function () { return [] }).then(function (all) {
      wordsAll = all
      return all
    }).finally(function () { continueRender(handle) })
    return wordsPending
  }
  function wordsOf(which) {
    if (!wordsAll) { ensureWords(); return [] }
    return which ? wordsAll.filter(function (w) { return w.track === which || w.file === which }) : wordsAll
  }
  async function analyse(which) {
    let tracks = []
    const list = await readManifestTracks()
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
      ensureWords()
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
    // The REAL words of the voice (or the sung line), moved to the piece clock:
    // [{ text, start, end, track }] in seconds. Needs audio.load() at the top. The times come
    // from audio_generate({ timings: true }) / motion_asset({ words: true }) — never typed by hand.
    words: function (which) { return wordsOf(which) },
    // The same words grouped in lines: [{ start, end, text, words }]. opts: { maxWords: 7, pause: 0.35 }.
    lines: function (which, opts) { return orbitWordLines(wordsOf(which), opts) },
    // A promise that settles once the word times are loaded (spans and scenes sized by the voice need them).
    ready: function () { return ensureWords() },
    // From the first word's start to the last word's end of a track (piece seconds): the length
    // of a narration, to size a scene by it. null until the words are loaded (see audio.load()).
    span: function (which) {
      const list = wordsOf(which)
      return list.length ? { start: list[0].start, end: list[list.length - 1].end } : null
    },
    // Index (in words()) of the word being spoken at t seconds, -1 before the first one.
    wordAt: function (t, which) { return orbitWordAt(wordsOf(which), t) },
    // When a word or phrase is first spoken (piece seconds), -1 if it never is: find('humilde', { after: 56 }).
    find: function (text, opts) {
      const o = opts || {}
      return orbitFindWord(wordsOf(o.track), text, o.after)
    },
  }
`
