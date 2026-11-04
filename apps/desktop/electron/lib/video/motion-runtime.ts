import { propsScriptTag } from './motion-props'
import { MOTION_AUDIO_LOADER_SCRIPT, MOTION_HELPERS_SCRIPT } from './motion-helpers'
import { MOTION_TIMING_SCRIPT } from './motion-timing'
import { MOTION_TRANSITIONS_SCRIPT } from './motion-transitions'
import { hasOwnImportMap, motionImportMapTag } from './motion-three'

/**
 * The seek runtime of motion compositions — the ONLY place where the seek
 * contract lives, shared by two paths:
 *
 *  1. the RENDER (motion.ts), which loads the composition in an offscreen window and
 *     injects this script via executeJavaScript;
 *  2. the PREVIEW (panel tab), which serves the composition's folder through
 *     `orbit-motion://` and injects the script as the FIRST script of the `<head>`
 *     (`/__orbit-runtime.js`), talking to the host via postMessage.
 *
 * The unit of time is WHOLE FRAME: `window.orbitMotion.seek(frame)` receives an
 * integer and converts internally to seconds (`t = frame / fps`). Whole
 * frame eliminates the float drift of the accumulated `frame / fps` and allows splitting
 * a track into exact frames (the same reason why Remotion works in
 * frames).
 *
 * The text is a string on purpose: it runs ON the page, not in the main. The copy
 * here is the source of truth — the render and the protocol serve exactly this
 * script. The SAME bridge rules hold in the pure parsing functions below,
 * which the tests cover and which the host uses to validate what arrives.
 */

/** App fps — the composition may declare another, but this is the default. */
export const MOTION_FPS = 30

/** Contract version; the composition reads it in window.orbitMotion.version. */
export const MOTION_RUNTIME_VERSION = 1

/** Mark of the bridge messages (host ⇄ iframe). */
export const MOTION_SOURCE = 'orbit-motion'

/** Reserved path that serves the runtime script from the composition's folder. */
export const MOTION_RUNTIME_PATH = '/__orbit-runtime.js'

/**
 * The runtime script. It preserves what already worked in the old render (the GSAP
 * global timeline, document.getAnimations(), document.fonts.ready, the double rAF,
 * the <video> seek and the care with HiDPI) and adds the contract in frames,
 * delayRender/continueRender, the postMessage bridge and the play mode.
 */
export const MOTION_RUNTIME = `(() => {
  if (window.__orbitMotionReady) return
  window.__orbitMotionReady = true

  const FPS = ${MOTION_FPS}
  const VERSION = ${MOTION_RUNTIME_VERSION}
  const SOURCE = '${MOTION_SOURCE}'
  // A delayRender() that nobody closes CANNOT hang the seek forever:
  // it blows up into an error (the composition has a bug and the host must know).
  const HANDLE_TIMEOUT_MS = 10000

  // --------------------------------------------------------------- state
  const declared = {}          // numbers the COMPOSITION declared
  const resolved = { width: 1920, height: 1080, fps: FPS, duration: undefined, durationInFrames: undefined }
  let failedFonts = []
  // Script errors of the composition (a throw, a rejected promise, a script or module that
  // did not load). Silent otherwise: the piece "loaded" with 1 s and no seek, and the only
  // clue was a console nobody reads. They travel in the spec and reach the tool result.
  const scriptErrors = []
  function noteScriptError(text) {
    text = String(text).slice(0, 300)
    if (scriptErrors.indexOf(text) === -1 && scriptErrors.length < 8) scriptErrors.push(text)
  }
  window.addEventListener('error', function (ev) {
    const t = ev && ev.target
    if (t && t !== window && t.tagName) {
      noteScriptError('failed to load <' + t.tagName.toLowerCase() + '> ' + (t.src || t.href || ''))
    } else if (ev) {
      const where = ev.filename ? ' (' + String(ev.filename).split('/').pop() + ':' + ev.lineno + ')' : ''
      noteScriptError((ev.message || (ev.error && ev.error.message) || 'script error') + where)
    }
  }, true)
  window.addEventListener('unhandledrejection', function (ev) {
    const r = ev && ev.reason
    noteScriptError('unhandled promise rejection: ' + (r && r.message ? r.message : String(r)))
  })
  let customSeek = null        // the composition own seek (canvas/three.js)
  let currentFrame = 0

  // The composition may have declared window.orbitMotion = { … } BEFORE the runtime
  // (it is the render case, which injects the script after the load). The numbers are
  // kept, and a seek of its own; the rest of the API is attached to the SAME object so as not to
  // invalidate the reference the page already has.
  const seed = window.orbitMotion && typeof window.orbitMotion === 'object' ? window.orbitMotion : null
  if (seed) {
    for (const k of ['width', 'height', 'fps', 'duration', 'durationInFrames']) {
      const v = seed[k]
      if (typeof v === 'number' && isFinite(v) && v > 0) declared[k] = v
    }
    if (typeof seed.seek === 'function') customSeek = seed.seek
  }
  const api = seed || {}

  // ----------------------------------------------------------- transitions
  // Validation and keyframes of the transitions (motion-transitions.ts): the same text
  // the tests execute, embedded here because the page has no import.
${MOTION_TRANSITIONS_SCRIPT}
  // The time of media (video and GIF) as a function of the piece instant (motion-timing.ts).
${MOTION_TIMING_SCRIPT}
${MOTION_HELPERS_SCRIPT}
  const transitions = []       // what the composition registered (lint and report)
  // The animations the runtime created (the transitions ones). document.getAnimations()
  // only returns the RELEVANT ones: an animation that ended, without a fill keeping it in effect,
  // leaves the list — and going back in time (dragging the ruler backwards, the play loop)
  // would leave it stuck at the end, with the "after" scene still visible on frame 0.
  const ownAnimations = []
  // Puts EVERY animation of the page at instant t: the ones the page has (CSS, WAAPI) and
  // ours, even the ones that already left the list.
  function positionAnimations(t) {
    const seen = new Set()
    for (const a of document.getAnimations()) {
      seen.add(a)
      try { a.pause(); a.currentTime = t * 1000 } catch (err) {}
    }
    for (const a of ownAnimations) {
      if (seen.has(a)) continue
      try { a.pause(); a.currentTime = t * 1000 } catch (err) {}
    }
  }

  // --------------------------------------------------------------- spec
  function metaContent() {
    const el = document.querySelector('meta[name="orbit-motion"]')
    return el ? el.getAttribute('content') : null
  }
  function readMeta() {
    const out = {}
    const raw = metaContent()
    if (!raw) return out
    for (const pair of String(raw).split(/[,;]/)) {
      const at = pair.indexOf('=')
      if (at < 0) continue
      const key = pair.slice(0, at).trim()
      const num = Number(pair.slice(at + 1).trim())
      if (!isFinite(num) || num <= 0) continue
      if (key === 'width' || key === 'height' || key === 'fps' || key === 'duration') out[key] = num
    }
    return out
  }
  function timelineDuration() {
    const tl = window.orbitTimeline
    return tl && typeof tl.duration === 'function' ? tl.duration() : undefined
  }
  // Precedence preserved from the old render: what the composition declared wins over the
  // <meta>, which wins over the default. The length has NO default — without it the
  // render has to fail instead of guessing a size.
  //
  // The length may be declared in FRAMES (durationInFrames, the new
  // contract) or in seconds (duration / timeline / meta). Frames is canonical and
  // rules: in seconds, it is converted ONCE with the resolved fps.
  function refresh() {
    const meta = readMeta()
    const fps = declared.fps || meta.fps || FPS
    const declaredFrames = declared.durationInFrames ? Math.max(1, Math.round(declared.durationInFrames)) : 0
    const seconds = declaredFrames ? declaredFrames / fps : declared.duration || timelineDuration() || meta.duration
    resolved.fps = fps
    resolved.width = declared.width || meta.width || 1920
    resolved.height = declared.height || meta.height || 1080
    resolved.duration = seconds
    resolved.durationInFrames = seconds ? Math.max(1, Math.round(seconds * fps)) : undefined
    return resolved
  }

  // --------------------------------------------------------- postMessage bridge
  function post(type, payload) {
    const parent = window.parent
    if (!parent || parent === window) return   // top (render window): nobody to listen
    try {
      const message = Object.assign({ source: SOURCE, type: type }, payload || {})
      parent.postMessage(message, '*')
    } catch (err) { /* the host is already gone */ }
  }
  function reportError(err) {
    post('error', {
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined,
    })
  }

  // --------------------------------------------------- delayRender/continueRender
  // The composition opens a handle before loading something asynchronous (font, image,
  // fetch) and closes it when done; the seek waits for the open handles.
  const openHandles = new Set()
  let handleSeq = 1
  let waiters = []
  function flushWaiters() {
    const list = waiters
    waiters = []
    for (const fn of list) fn()
  }
  function delayRender() {
    const handle = handleSeq++
    openHandles.add(handle)
    return handle
  }
  function continueRender(handle) {
    if (openHandles.delete(handle) && openHandles.size === 0) flushWaiters()
  }
${MOTION_AUDIO_LOADER_SCRIPT}
  function waitForHandles() {
    if (openHandles.size === 0) return Promise.resolve()
    return new Promise(function (resolve, reject) {
      let timer = 0
      function waiter() {
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(function () {
        const at = waiters.indexOf(waiter)
        if (at >= 0) waiters.splice(at, 1)
        reject(new Error('orbit-motion: a delayRender() handle was not released within ' + HANDLE_TIMEOUT_MS + 'ms'))
      }, HANDLE_TIMEOUT_MS)
      waiters.push(waiter)
    })
  }

  // --------------------------------------------------------------- seek
  // GSAP is read from window on every use (not captured here): in the preview the
  // runtime is the first script of the head and the composition gsap.min.js loads
  // AFTERWARDS — capturing it now would give undefined and the timeline would never be fetched.
  let gsapReady = false
  let gsapBase = 0
  function prepareGsap() {
    if (gsapReady || customSeek) return
    const g = window.gsap
    if (!g) return
    gsapReady = true
    g.ticker.lagSmoothing(0)
    if (window.orbitTimeline) window.orbitTimeline.pause()
    else {
      const kids = g.globalTimeline.getChildren(false, true, true)
      gsapBase = kids.length ? Math.min.apply(null, kids.map(function (k) { return k.startTime() })) : 0
      g.globalTimeline.pause()
    }
  }
  function videos() {
    return Array.prototype.slice.call(document.querySelectorAll('video'))
  }
  // The time attributes of a <video> (data-start / data-in / data-end), in seconds.
  function numberAttr(el, name) {
    const raw = el.getAttribute(name)
    if (raw === null || raw === '') return undefined
    const n = Number(raw)
    return isFinite(n) ? n : undefined
  }
  function mediaTiming(v) {
    return {
      start: numberAttr(v, 'data-start'),
      in: numberAttr(v, 'data-in'),
      end: numberAttr(v, 'data-end'),
      loop: v.loop,
      duration: v.duration,
    }
  }
  // What the host needs to know about the <video>s: where the sound comes from, and at what time.
  // The runtime MUTES the page video (the render window has no sound), so it is
  // the host that puts its sound into the mix — from this snapshot.
  function videoFacts() {
    return videos().map(function (v) {
      return {
        src: v.currentSrc || v.getAttribute('src') || '',
        muted: v.hasAttribute('muted') || v.getAttribute('data-audio') === 'false',
        loop: v.loop,
        gain: numberAttr(v, 'data-gain') || 0,
        start: numberAttr(v, 'data-start') || 0,
        in: numberAttr(v, 'data-in') || 0,
        end: numberAttr(v, 'data-end'),
      }
    })
  }

  // ----------------------------------------------------------------- GIF
  // An <img> GIF animates on its own, on the wall clock: two renders would show
  // different frames. Here the GIF is decoded (ImageDecoder) into whole frames
  // and the <img> starts showing the frame the INSTANT demands — the element
  // stays the same, so CSS, object-fit, transform and data-layer still apply.
  const gifs = []
  const MAX_GIF_FRAMES = 1500
  function isGifImage(img) {
    const src = (img.getAttribute('src') || '').split('#')[0].split('?')[0].toLowerCase()
    return src.slice(-4) === '.gif'
  }
  async function prepareGif(img) {
    const response = await fetch(img.currentSrc || img.src)
    const data = await response.arrayBuffer()
    const decoder = new ImageDecoder({ data: data, type: 'image/gif' })
    await decoder.tracks.ready
    const count = decoder.tracks.selectedTrack.frameCount
    if (count > MAX_GIF_FRAMES) throw new Error('GIF has ' + count + ' frames (more than ' + MAX_GIF_FRAMES + ')')
    const urls = []
    const durations = []
    for (let i = 0; i < count; i++) {
      const result = await decoder.decode({ frameIndex: i })
      const frame = result.image
      const canvas = document.createElement('canvas')
      canvas.width = frame.displayWidth
      canvas.height = frame.displayHeight
      canvas.getContext('2d').drawImage(frame, 0, 0)
      durations.push(orbitGifDelay(frame.duration === null ? undefined : frame.duration / 1000000))
      frame.close()
      const blob = await new Promise(function (r) { canvas.toBlob(r, 'image/png') })
      urls.push(URL.createObjectURL(blob))
    }
    decoder.close()
    img.removeAttribute('srcset')
    gifs.push({
      img: img,
      urls: urls,
      durations: durations,
      start: numberAttr(img, 'data-start') || 0,
      loop: img.getAttribute('data-loop') !== 'false',
      shown: -1,
    })
  }
  async function prepareGifs() {
    if (typeof ImageDecoder === 'undefined') return
    const handle = delayRender()
    try {
      for (const img of Array.prototype.slice.call(document.querySelectorAll('img'))) {
        if (!isGifImage(img)) continue
        try { await prepareGif(img) } catch (err) { reportError(err) }
      }
    } finally {
      continueRender(handle)
    }
  }
  async function applyGifs(t) {
    for (const g of gifs) {
      const index = orbitGifFrame(t - g.start, g.durations, g.loop)
      if (index === g.shown) continue
      g.shown = index
      g.img.src = g.urls[index]
      try { await g.img.decode() } catch (err) {}
    }
  }
  for (const v of videos()) { v.muted = true; v.pause() }
  // Pauses GSAP right at entry (as the old render did): the composition cannot
  // run on its own before the first seek.
  prepareGsap()

  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r) }) })
  }

  async function applyFrame(frame) {
    currentFrame = frame
    const t = frame / resolved.fps
    if (customSeek) await customSeek(frame)
    else {
      prepareGsap()
      const g = window.gsap
      if (g) {
        if (window.orbitTimeline) window.orbitTimeline.seek(t, false)
        else g.globalTimeline.seek(gsapBase + t, false)
      }
    }
    // The cameras go AFTER the composition's own seek: they own the transform of their layers.
    for (const c of cameras) c.apply(frame)
    positionAnimations(t)
    await Promise.all(videos().map(function (v) {
      return new Promise(function (res) {
        // The runtime is the first script of the <head>: at boot the page <video>s
        // DO NOT EXIST YET, so muting only there caught none of them. It is here, on every
        // frame, that the video stops playing on its own (autoplay) — its sound enters
        // through the host mix, never through the page.
        v.muted = true
        v.pause()
        const target = orbitVideoTime(t, mediaTiming(v))
        if (Math.abs(v.currentTime - target) < 0.001) return res()
        v.addEventListener('seeked', res, { once: true })
        v.currentTime = target
        setTimeout(res, 2000)
      })
    }))
    await applyGifs(t)
    await nextFrame()
  }

  // latest-wins: a seek that arrives while another one runs REPLACES the previous one (which
  // is discarded, never queued). In play mode the rAF asks for one frame at a time and
  // the machine never piles up overlapping seeks.
  let queued = null
  let running = false
  function pump() {
    if (running) return
    running = true
    ;(async function () {
      try {
        while (queued) {
          const job = queued
          queued = null
          try {
            await waitForHandles()
            // A newer request arrived while this one was waiting (delayRender,
            // font, rAF): this one is stale and leaves without applying anything.
            if (queued) { job.resolve(); continue }
            await applyFrame(job.f)
            job.resolve()
          } catch (err) {
            reportError(err)
            job.reject(err)
          }
        }
      } finally {
        running = false
      }
    })()
  }
  function seekFrame(frame) {
    const f = Math.max(0, Math.round(Number(frame) || 0))
    return new Promise(function (resolve, reject) {
      if (queued) queued.resolve()   // stale request: leaves without doing anything
      queued = { f: f, resolve: resolve, reject: reject }
      pump()
    })
  }

  // --------------------------------------------------------------- play
  let playing = false
  let loopOn = false
  let rafId = 0
  let playBase = 0
  let playBaseFrame = 0
  function play() {
    if (playing) return
    playing = true
    playBase = performance.now()
    playBaseFrame = currentFrame
    function tick() {
      if (!playing) return
      const elapsed = (performance.now() - playBase) / 1000
      let frame = playBaseFrame + Math.round(elapsed * resolved.fps)
      const total = resolved.durationInFrames
      if (total && frame >= total) {
        if (loopOn) {
          // With loop on, play WRAPS AROUND. The question has to be
          // "frame >= total": with "frame >= total - 1" in the other branch, the last
          // frame fell into it first and play died there — with loop on.
          playBase = performance.now()
          playBaseFrame = 0
          frame = 0
        } else {
          // Without loop, it stops on the LAST frame (stuck on it, not on a frame that does not
          // exist).
          frame = total - 1
          seekFrame(frame).catch(function () {})
          post('time', { frame: frame })
          pause()
          return
        }
      }
      seekFrame(frame).catch(function () {})
      post('time', { frame: frame })
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
  }
  function pause() {
    playing = false
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
  }

  // ------------------------------------------------------------- camera
  // orbitMotion.camera({ world: '#world', start: { x, y, zoom, rot } }) → a controller.
  // The DIRECT CHILDREN of the world element are the layers: the camera owns their transform
  // (animate what is inside them, not them) and gives each one a depth with data-depth="2"
  // (farther: moves less) or "0.5" (nearer: moves more). The camera is applied by the runtime on
  // every seek, after the composition's own seek, so it is a pure function of the frame.
  const cameras = []
  function addCamera(opts) {
    const o = opts || {}
    const worldEl = typeof o.world === 'string' ? document.querySelector(o.world) : o.world
    if (!worldEl || !worldEl.children) throw new Error('camera: world not found — pass { world: "#world" }, the element whose children are the layers')
    const items = []   // moves and focus() requests, in the order given
    const shakes = []
    const conflicts = new Set()   // layers whose transform is also written by the page itself
    // A name the agent can find: data-layer, id, first class — else its position among the layers.
    function layerName(el) {
      const named = el.getAttribute('data-layer') || el.id || String(el.className || '').split(' ')[0]
      return named || 'layer ' + (layers().indexOf(el) + 1)
    }
    let cache = null   // { initial, plan }, built the first time it is needed (fonts and layout are in by then)
    function viewSize() { return { w: o.width || resolved.width, h: o.height || resolved.height } }
    function layers() {
      return Array.prototype.filter.call(worldEl.children, function (el) { return !/^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT)$/.test(el.tagName) })
    }
    function measure(target) {
      const el = typeof target === 'string' ? document.querySelector(target) : target
      if (!el) throw new Error('camera: focus target not found: ' + target)
      const ls = layers()
      const saved = ls.map(function (l) { return l.style.transform })
      ls.forEach(function (l) { l.style.transform = 'none' })
      const wr = worldEl.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      ls.forEach(function (l, i) { l.style.transform = saved[i] })
      if (r.width < 1 || r.height < 1) throw new Error('camera: focus target ' + target + ' has no size — it is display:none or empty. Hide a layer with opacity/visibility, not display:none, or pass { rect: { x, y, w, h } }')
      return { x: r.left - wr.left, y: r.top - wr.top, w: r.width, h: r.height }
    }
    function build() {
      if (cache) return cache
      const v = viewSize()
      const start = o.start || {}
      const initial = {
        x: start.x === undefined ? v.w / 2 : start.x,
        y: start.y === undefined ? v.h / 2 : start.y,
        zoom: start.zoom === undefined ? 1 : start.zoom,
        rot: start.rot === undefined ? 0 : start.rot,
      }
      const list = items.map(function (it) {
        if (!it.focus) return it.move
        const rect = it.move.rect || measure(it.target)
        const fit = orbitCameraFit(rect, v.w, v.h, it.move)
        return Object.assign({}, it.move, { to: { x: fit.x, y: fit.y, zoom: fit.zoom, rot: it.move.rot === undefined ? undefined : it.move.rot } })
      })
      cache = { initial: initial, plan: orbitCameraPlan(initial, list) }
      return cache
    }
    const cam = {
      // { at, dur, to: { x, y, zoom, rot }, style: 'ease'|'linear'|'push'|'pull'|'slingshot'|'whip', back, overshoot } — seconds
      move: function (m) { items.push({ move: m || {} }); cache = null; return cam },
      // Frames an element (or { rect }) — fit: 'contain' | 'cover', padding (px), scale.
      focus: function (target, m) { items.push({ focus: true, target: target, move: Object.assign({}, m) }); cache = null; return cam },
      // The camera flies INTO the element until it fills the frame (the zoom-through): build the
      // next scene in the same colour/texture and the object becomes its background.
      zoomThrough: function (target, m) {
        const mm = Object.assign({ style: 'push', fit: 'cover', scale: 1.02 }, m)
        items.push({ focus: true, target: target, move: mm }); cache = null; return cam
      },
      shake: function (s) {
        const x = s || {}
        shakes.push({ at: x.at || 0, dur: x.dur || 0.4, amp: x.amp === undefined ? 18 : x.amp, rot: x.rot === undefined ? 0.6 : x.rot, freq: x.freq || 24, seed: x.seed === undefined ? 'shake' + shakes.length : x.seed })
        return cam
      },
      // The camera at time t (seconds), shake included — read it with motion_frame evaluate.
      at: function (t) {
        const b = build()
        const s = orbitCameraState(b.initial, b.plan, t)
        const k = orbitCameraShake(shakes, t)
        return { x: s.x + k.x, y: s.y + k.y, zoom: s.zoom, rot: s.rot + k.rot }
      },
      plan: function () { return build().plan.map(function (m) { return { at: m.at, dur: m.dur, style: m.style, from: m.from, to: m.to } }) },
      apply: function (frame) {
        const s = cam.at(frame / resolved.fps)
        const v = viewSize()
        const round = function (n) { return Math.round(n * 10000) / 10000 }
        layers().forEach(function (el) {
          // Somebody else owns this transform too? The camera is about to overwrite it, so that
          // animation never shows — the report and the lint say so instead of leaving it silent.
          const written = el.style.transform
          if (written && written !== el.__orbitCamera) conflicts.add(layerName(el))
          else if (!written && el.__orbitCamera === undefined && typeof getComputedStyle === 'function') {
            try { if (getComputedStyle(el).transform !== 'none') conflicts.add(layerName(el)) } catch (err) {}
          }
          if (typeof el.getAnimations === 'function') {
            try {
              const animated = el.getAnimations().some(function (a) {
                return a.effect && typeof a.effect.getKeyframes === 'function' && a.effect.getKeyframes().some(function (k) { return k.transform !== undefined })
              })
              if (animated) conflicts.add(layerName(el))
            } catch (err) {}
          }
          const depth = parseFloat(el.getAttribute('data-depth')) || 1
          const m = orbitCameraMatrix(s, depth, v.w, v.h)
          el.style.transformOrigin = '0 0'
          el.style.transform = 'matrix(' + m.map(round).join(',') + ')'
          el.__orbitCamera = el.style.transform
        })
      },
      // What the page tells the report and the lint: the plan, the layers, the conflicts.
      info: function () {
        let moves = []
        let error
        try {
          moves = build().plan.map(function (m) { return { at: m.at, dur: m.dur, style: m.style, from: m.from, to: m.to } })
        } catch (err) { error = String((err && err.message) || err) }
        return { layers: layers().length, moves: moves, shakes: shakes.length, conflicts: Array.from(conflicts), error: error }
      },
    }
    cameras.push(cam)
    return cam
  }

  // ------------------------------------------------------------- transition
  // orbitMotion.transition({ out, in, at, duration, type, direction, easing, amount })
  // becomes one paused animation per element. There is NOTHING to do per frame: the
  // applyFrame already puts every document.getAnimations() at t * 1000, so the
  // transition is fetched like any @keyframes — preview, measurement and render.
  function transitionTarget(ref, role) {
    if (ref === undefined || ref === null) return null
    if (typeof ref === 'string') {
      const found = document.querySelector(ref)
      if (!found) throw new Error('orbit-motion transition: no element matches "' + ref + '" (' + role + ')')
      return found
    }
    if (typeof ref.animate === 'function') return ref
    throw new Error('orbit-motion transition: "' + role + '" must be a selector or an element')
  }
  function transitionLabel(ref) {
    if (ref === undefined || ref === null) return null
    if (typeof ref === 'string') return ref
    if (ref.id) return '#' + ref.id
    return String(ref.tagName || 'element').toLowerCase()
  }
  function addTransition(raw) {
    const parsed = orbitNormalizeTransition(raw)
    if (parsed.error) throw new Error('orbit-motion transition: ' + parsed.error)
    const spec = parsed.spec
    const outEl = transitionTarget(raw.out, 'out')
    const inEl = transitionTarget(raw.in, 'in')
    if (outEl && outEl === inEl) throw new Error('orbit-motion transition: "out" and "in" are the same element')
    const plan = orbitTransitionKeyframes(spec)
    const now = (currentFrame / resolved.fps) * 1000
    function run(el, frames, fill) {
      const animation = el.animate(frames, {
        delay: spec.at * 1000,
        duration: spec.duration * 1000,
        easing: spec.easing,
        fill: fill,
      })
      animation.pause()
      try { animation.currentTime = now } catch (err) {}
      ownAnimations.push(animation)
    }
    if (outEl) run(outEl, plan.out, 'forwards')
    if (inEl) run(inEl, plan.in, 'backwards')
    const info = {
      type: spec.type,
      direction: spec.direction,
      at: spec.at,
      duration: spec.duration,
      out: transitionLabel(raw.out),
      in: transitionLabel(raw.in),
    }
    transitions.push(info)
    return Object.assign({ end: spec.at + spec.duration }, info)
  }

  // ------------------------------------------------------------- scenes
  // orbitMotion.scenes([{ name, dur }]) (motion-helpers.ts) lays the scenes out one after the
  // other. When the piece does not pin its own length (no duration in the meta, none declared,
  // no timeline), the sum of the scenes IS the length — one fewer number to keep in step.
  let sceneInfo = []
  let scenesSetLength = false
  function declareScenes(list, opts) {
    const laid = orbitScenes(list, opts)
    sceneInfo = laid.list.map(function (s) { return { name: s.name, start: s.start, end: s.end } })
    const fps = refresh().fps
    if (scenesSetLength || (!declared.durationInFrames && !declared.duration && !readMeta().duration && !timelineDuration())) {
      scenesSetLength = true
      declared.durationInFrames = Math.max(1, Math.ceil(laid.total * fps - 1e-6))
    }
    announce()
    return laid
  }

  // ------------------------------------------------------------- measure text
  // Text measured IN THE PAGE with its real font (a hidden box laid out by the browser), so
  // "does 'EQUILIBRIO' at 104 px fit in 952 px?" is answered before it is written. Layout units
  // (offsetWidth/Height), so a scaled preview does not change the answer. Call it once at the
  // start (after the fonts are in): the result is a pure function of the arguments.
  const TEXT_STYLE_KEYS = ['fontFamily', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform', 'lineHeight', 'fontVariant']
  const textCache = new Map()
  function textStyleOf(source, opts) {
    const style = {}
    if (source && source.nodeType === 1) {
      const cs = getComputedStyle(source)
      for (const k of TEXT_STYLE_KEYS) style[k] = cs[k]
      style.fontSize = parseFloat(cs.fontSize)
    }
    for (const k of TEXT_STYLE_KEYS.concat(['fontSize'])) if (opts && opts[k] !== undefined) style[k] = opts[k]
    return style
  }
  function layoutText(text, style, size, maxWidth, nowrap) {
    const box = document.createElement('div')
    const s = box.style
    s.position = 'fixed'; s.left = '-99999px'; s.top = '0'; s.visibility = 'hidden'
    s.margin = '0'; s.padding = '0'; s.border = '0'
    s.whiteSpace = nowrap ? 'nowrap' : 'normal'
    s.width = nowrap || !maxWidth ? 'max-content' : maxWidth + 'px'
    for (const k of TEXT_STYLE_KEYS) if (style[k]) s[k] = style[k]
    s.fontSize = size + 'px'
    box.textContent = text
    document.body.appendChild(box)
    const out = { width: box.offsetWidth, height: box.offsetHeight, scrollWidth: box.scrollWidth }
    document.body.removeChild(box)
    return out
  }
  function measureNow(text, style, size, maxWidth) {
    const one = layoutText('Hg', style, size, 0, true).height || size * 1.2
    if (!maxWidth) {
      const m = layoutText(text, style, size, 0, true)
      return { width: m.width, height: m.height, lines: 1, overflowX: false }
    }
    const m = layoutText(text, style, size, maxWidth, false)
    return { width: Math.min(maxWidth, m.scrollWidth), height: m.height, lines: Math.max(1, Math.round(m.height / one)), overflowX: m.scrollWidth > maxWidth + 0.5 }
  }
  function textArg(first, opts) {
    const source = first && first.nodeType === 1 ? first : null
    const text = source ? (source.innerText || source.textContent || '') : String(first)
    return { text: text.replace(/\\s+/g, ' ').trim(), style: textStyleOf(source, opts) }
  }
  // orbitMotion.measureText(textOrElement, { fontSize, fontFamily, fontWeight, letterSpacing, maxWidth })
  //   → { width, height, lines, overflowX }. Without maxWidth: one line, its natural width.
  function measureTextDom(first, opts) {
    const a = textArg(first, opts)
    return measureNow(a.text, a.style, a.style.fontSize || 16, opts && opts.maxWidth)
  }
  // orbitMotion.fitText(textOrElement, { maxWidth, maxLines: 1, maxHeight, min: 8, max: 600, …style })
  //   → { fontSize, lines, width, height, fits }: the largest size at which the text stays inside the box.
  function fitTextDom(first, opts) {
    const o = opts || {}
    if (!(o.maxWidth > 0)) throw new Error('fitText: pass { maxWidth } in px')
    const a = textArg(first, o)
    const maxLines = o.maxLines || 1
    const key = JSON.stringify([a.text, a.style, o.maxWidth, maxLines, o.maxHeight, o.min, o.max])
    const loading = document.fonts && document.fonts.status === 'loading'
    if (!loading && textCache.has(key)) return Object.assign({}, textCache.get(key))
    function at(size) {
      return maxLines === 1 && !o.maxHeight ? measureNow(a.text, a.style, size, 0) : measureNow(a.text, a.style, size, o.maxWidth)
    }
    function ok(size) {
      const m = at(size)
      if (maxLines === 1 && !o.maxHeight) return m.width <= o.maxWidth + 0.5
      return !m.overflowX && m.lines <= maxLines && (!o.maxHeight || m.height <= o.maxHeight)
    }
    const best = orbitFitSize(ok, o.min || 8, o.max || 600)
    const size = best === null ? Math.ceil(o.min || 8) : best
    const m = at(size)
    const result = { fontSize: size, lines: m.lines, width: m.width, height: m.height, fits: best !== null }
    if (!loading) {
      if (textCache.size > 500) textCache.clear()
      textCache.set(key, result)
    }
    return Object.assign({}, result)
  }

  // --------------------------------------------------------------- API
  // window.orbitMotion is the contract: the composition reads fps/width/height/
  // durationInFrames and uses delayRender/continueRender; the host calls seek(frame).
  // The numbers and the seek are ACCESSORS: assigning (the composition declaring its
  // own format or its own seek) lands in the right place instead of wiping the API.
  function defineNumbers() {
    for (const k of ['width', 'height', 'fps', 'duration']) {
      Object.defineProperty(api, k, {
        configurable: true,
        enumerable: true,
        get: function () { return resolved[k] },
        // Declaring the format AFTER the runtime (the composition script) re-announces
        // ready, instead of leaving the host with the old value.
        set: function (v) {
          if (typeof v === 'number' && isFinite(v) && v > 0) declared[k] = v
          announce()
        },
      })
    }
    // durationInFrames accepts assignment: the composition declares the length in
    // frames (window.orbitMotion = { durationInFrames: 120 }) and the value becomes the
    // canonical one of the resolution.
    Object.defineProperty(api, 'durationInFrames', {
      configurable: true,
      enumerable: true,
      get: function () { return resolved.durationInFrames },
      set: function (v) {
        if (typeof v === 'number' && isFinite(v) && v > 0) declared.durationInFrames = v
        announce()
      },
    })
    Object.defineProperty(api, 'failedFonts', {
      configurable: true,
      enumerable: true,
      get: function () { return failedFonts },
    })
    Object.defineProperty(api, 'seek', {
      configurable: true,
      enumerable: true,
      get: function () { return seekFrame },
      set: function (fn) { if (typeof fn === 'function') customSeek = fn },
    })
    Object.defineProperty(api, 'version', { value: VERSION, writable: true, enumerable: true, configurable: true })
    api.delayRender = delayRender
    api.continueRender = continueRender
    api.transition = addTransition
    api.camera = addCamera
    // Props of the piece (props.json + the overrides of this render): fixed for the whole run.
    Object.defineProperty(api, 'props', {
      configurable: true,
      enumerable: true,
      get: function () { return Object.freeze(Object.assign({}, window.__orbitProps || {})) },
    })
    // Remotion-style primitives (motion-helpers.ts): pure functions of the frame.
    api.interpolate = orbitInterpolate
    api.spring = function (o) { return orbitSpring(Object.assign({ fps: resolved.fps }, o)) }
    api.Easing = orbitEasing
    api.sequence = orbitSequence
    api.scenes = declareScenes
    api.random = orbitRandom
    api.measureText = measureTextDom
    api.fitText = fitTextDom
    api.audio = audioApi
    Object.defineProperty(api, 'transitions', {
      configurable: true,
      enumerable: true,
      get: function () { return transitions.map(function (t) { return Object.assign({}, t) }) },
    })
  }
  try {
    defineNumbers()
    Object.defineProperty(window, 'orbitMotion', {
      configurable: true,
      enumerable: true,
      get: function () { return api },
      // Assigning window.orbitMotion = { duration: 4 } (old declaration) MERGES
      // into the API instead of swapping the object — otherwise delayRender/seek would vanish.
      set: function (value) {
        if (!value || typeof value !== 'object' || value === api) return
        for (const k of Object.keys(value)) {
          if (k === 'seek') { if (typeof value.seek === 'function') customSeek = value.seek; continue }
          try { api[k] = value[k] } catch (err) {}
        }
        announce()
      },
    })
  } catch (err) {
    // There is already a non-configurable window.orbitMotion: go on with what we got.
  }

  // Snapshot of the state for the RENDER host (which reads it through executeJavaScript, without a
  // bridge). Same names as the old PAGE_SPEC so the render keeps the precedence.
  window.__orbitMotionSpec = function () {
    return {
      meta: metaContent(),
      width: resolved.width,
      height: resolved.height,
      fps: resolved.fps,
      duration: resolved.duration,
      durationInFrames: resolved.durationInFrames,
      failedFonts: failedFonts.slice(),
      scriptErrors: scriptErrors.slice(),
      devicePixelRatio: window.devicePixelRatio || 1,
      transitions: transitions.map(function (t) { return Object.assign({}, t) }),
      scenes: sceneInfo.map(function (s) { return Object.assign({}, s) }),
      cameras: cameras.map(function (c) { try { return c.info() } catch (err) { return { layers: 0, moves: [], shakes: 0, conflicts: [], error: String((err && err.message) || err) } } }),
      videos: videoFacts(),
    }
  }

  // ------------------------------------------------------------- layers
  // Who appears and vanishes over time: scans the frames WITHOUT painting (only
  // style and layout, which getBoundingClientRect forces) and returns, per
  // element, the intervals in which it is visible — what the tab draws as
  // entry and exit bands. It runs in the main offscreen window, never in the
  // preview: the scan moves the playhead. WHICH elements become a
  // layer is the host call (motion-layers.ts), which only knows this raw snapshot.
  const SKIP_TAGS = /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT|BR|HEAD|TITLE)$/
  function layerLabel(el) {
    const named = el.getAttribute('data-layer')
    if (named) return named
    if (el.id) return '#' + el.id
    // Unnamed media: the FILE says more than the tag ("video") or the class
    // (".hero") — "Mimi.mp4" is what the person recognizes in the layer list.
    // Before the text because a <video> may carry the browser fallback.
    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      const src = String(el.currentSrc || el.getAttribute('src') || '')
      const file = src.split(/[?#]/)[0].split(/[\\\\/]/).filter(Boolean).pop()
      if (file) return file
    }
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    if (text) return text.length > 32 ? text.slice(0, 31) + '…' : text
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/)[0]
    return cls ? '.' + cls : el.tagName.toLowerCase()
  }
  // What kind of thing the layer is. The label says the NAME, not what the element is:
  // a heading and a photo can both be called ".caption". The order goes from the
  // concrete to the vague — a container that HAS media inside is the media (it is what
  // one sees), and only what has neither media nor text is left as "other".
  function layerKind(el) {
    const tag = (el.tagName || '').toUpperCase()
    if (tag === 'VIDEO') return 'video'
    if (tag === 'AUDIO') return 'audio'
    if (tag === 'IMG' || tag === 'PICTURE' || tag === 'CANVAS' || tag === 'SVG') return 'image'
    if (el.querySelector) {
      if (el.querySelector('video')) return 'video'
      if (el.querySelector('audio')) return 'audio'
      if (el.querySelector('img,picture,canvas,svg')) return 'image'
    }
    return (el.textContent || '').trim() ? 'text' : 'other'
  }
  function layerCandidates() {
    const out = []
    function walk(el, parent, depth) {
      for (const child of Array.prototype.slice.call(el.children)) {
        if (out.length >= 400) return
        if (SKIP_TAGS.test(child.tagName)) continue
        const index = out.length
        out.push({ el: child, parent: parent })
        if (depth < 6) walk(child, index, depth + 1)
      }
    }
    if (document.body) walk(document.body, -1, 0)
    return out
  }
  function isShown(el, vw, vh) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
    const r = el.getBoundingClientRect()
    if (r.width * r.height < 4) return false
    return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh
  }
  // The same path as applyFrame, without <video> and without waiting for the paint: the
  // scan only reads style and geometry.
  async function seekForProbe(frame) {
    currentFrame = frame
    const t = frame / resolved.fps
    if (customSeek) await customSeek(frame)
    else {
      prepareGsap()
      const g = window.gsap
      if (g) {
        if (window.orbitTimeline) window.orbitTimeline.seek(t, false)
        else g.globalTimeline.seek(gsapBase + t, false)
      }
    }
    positionAnimations(t)
  }

  // ------------------------------------------------------- layer highlight
  // The layer selected in the tab gets an outline HERE, in the preview document.
  // The host cannot reach this DOM (the stage is a sandbox without same-origin), so the one
  // that draws is the runtime, at its request. Two rules:
  //   - keep the 'outline' that was already there and give it back when unselected: the
  //     composition may have its own, and leaving the selection cannot leave a mark;
  //   - the index comes from the MEASUREMENT, taken in another window of the same composition. If the
  //     label does not match, the page changed in the meantime — better not to outline anything
  //     than to outline the wrong element.
  // It does not go through applyFrame(): the outline belongs to the ELEMENT, not to the frame, so
  // it follows by itself whatever the composition does with it (transform, keyframe).
  // The color is literal because the composition page does not have the app
  // CSS variables: it is the theme gold (the same hsl(44 100% 47%) as on mobile).
  const HIGHLIGHT_RING = '2px solid #f0b000'
  let highlighted = null
  let highlightedOutline = null
  function clearHighlight() {
    if (!highlighted) return
    highlighted.style.outline = highlightedOutline.outline
    highlighted.style.outlineOffset = highlightedOutline.offset
    highlighted = null
    highlightedOutline = null
  }
  function applyHighlight(index, name) {
    clearHighlight()
    if (typeof index !== 'number' || index < 0) return
    const item = layerCandidates()[index]
    if (!item) return
    if (name && layerLabel(item.el) !== name) return
    highlighted = item.el
    highlightedOutline = { outline: item.el.style.outline || '', offset: item.el.style.outlineOffset || '' }
    item.el.style.outline = HIGHLIGHT_RING
    // INSIDE (-2px) on purpose: the outline is painted outside the element
    // box, and the most common layer of all is the one that fills the whole screen — there
    // an outer outline would fall outside the viewport (or be clipped by the
    // stage overflow:hidden) and would not show up precisely on the layer that most
    // needs to be identified. Inside, it always shows.
    item.el.style.outlineOffset = '-2px'
  }

  window.__orbitMotionLayers = async function (maxSamples) {
    refresh()
    const total = resolved.durationInFrames
    if (!total) return { durationInFrames: 0, step: 1, layers: [] }
    await waitForHandles()
    const back = currentFrame
    const step = Math.max(1, Math.ceil(total / (maxSamples || 900)))
    const items = layerCandidates()
    const vw = resolved.width
    const vh = resolved.height
    const spans = items.map(function () { return [] })
    const open = items.map(function () { return -1 })
    let last = 0
    for (let f = 0; f < total; f += step) {
      await seekForProbe(f)
      for (let i = 0; i < items.length; i++) {
        const on = isShown(items[i].el, vw, vh)
        if (on && open[i] < 0) open[i] = f
        else if (!on && open[i] >= 0) { spans[i].push([open[i], f - 1]); open[i] = -1 }
      }
      last = f
    }
    for (let i = 0; i < items.length; i++) if (open[i] >= 0) spans[i].push([open[i], total - 1])
    await seekFrame(back).catch(function () {})
    return {
      durationInFrames: total,
      step: step,
      lastSample: last,
      layers: items.map(function (item, i) {
        return {
          name: layerLabel(item.el),
          named: item.el.hasAttribute('data-layer'),
          parent: item.parent,
          spans: spans[i],
          // Position in the page walk: it is the element address for the
          // highlight (the preview walks the same candidates, in the same order).
          index: i,
          kind: layerKind(item.el),
          // The tag separates the media from the container around it: a <div> with a
          // <video> inside is also "video" by the measured type, and the host needs
          // to know which of the two is the real layer (see pickLayers).
          tag: String(item.el.tagName || '').toLowerCase(),
        }
      }),
    }
  }

  // --------------------------------------------------------------- boot
  // HiDPI: the capture comes out at the screen scale factor and the host normalizes the image
  // (scale= in ffmpeg); here we only guarantee height in the document — without it the
  // offscreen window paints empty and the frame comes out blank.
  function syncDocumentHeight() {
    const root = document.documentElement
    if (!root || !resolved.height) return
    if (root.getBoundingClientRect().height === 0) root.style.height = resolved.height + 'px'
  }
  function reportAssets() {
    failedFonts = Array.prototype.slice.call(document.fonts || [])
      .filter(function (f) { return f.status === 'error' })
      .map(function (f) { return f.family })
    post('assets', { failedFonts: failedFonts })
  }
  let readyFrames = 0
  function announce() {
    refresh()
    const frames = resolved.durationInFrames
    // Only (re)announces when the length changed: the composition may declare the
    // format after the runtime (its script, in the middle of the head) and the host needs
    // to know; without a change, nothing is repeated.
    if (!frames || frames === readyFrames) return
    readyFrames = frames
    post('ready', {
      durationInFrames: resolved.durationInFrames,
      width: resolved.width,
      height: resolved.height,
      // The COMPOSITION fps goes along: the tab used to draw everything at a fixed 30, and a
      // 60 fps piece had the playhead, the ruler and the timecodes at half speed.
      fps: resolved.fps,
      version: VERSION,
    })
  }
  function boot() {
    syncDocumentHeight()
    announce()
  }
  // GIFs are decoded as soon as the document exists (and not only on load: the
  // render waits on delayRender, and the load may already have gone by).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { prepareGifs() }, { once: true })
  else prepareGifs()
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { reportAssets(); announce() })
  }
  if (document.readyState === 'complete') boot()
  else window.addEventListener('load', boot, { once: true })

  // Host commands (preview). Only from the parent: the composition is untrusted
  // content and does not command another page playhead.
  window.addEventListener('message', function (event) {
    if (window.parent !== window && event.source !== window.parent) return
    const cmd = parseCommand(event.data)
    if (!cmd) return
    if (cmd.type === 'seek') seekFrame(cmd.frame).catch(function () {})
    else if (cmd.type === 'play') play()
    else if (cmd.type === 'pause') pause()
    else if (cmd.type === 'loop') loopOn = cmd.on
    else if (cmd.type === 'highlight') applyHighlight(cmd.index, cmd.name)
  })

  // Same rules as the pure function parseMotionCommand (motion-runtime.ts) — here in page
  // JS, without import, because the runtime does not go through the bundler.
  function parseCommand(data) {
    if (!data || typeof data !== 'object' || data.source !== SOURCE) return null
    if (data.type === 'seek') return isFinite(data.frame) ? { type: 'seek', frame: Math.max(0, Math.round(data.frame)) } : null
    if (data.type === 'play') return { type: 'play' }
    if (data.type === 'pause') return { type: 'pause' }
    if (data.type === 'loop') return { type: 'loop', on: Boolean(data.on) }
    // A negative index is "remove the highlight": unselecting is a command, not the absence
    // of one — without it the mark would stay on screen until the next selection.
    if (data.type === 'highlight') {
      return {
        type: 'highlight',
        index: typeof data.index === 'number' && isFinite(data.index) ? Math.round(data.index) : -1,
        name: typeof data.name === 'string' ? data.name : null,
      }
    }
    return null
  }

  refresh()
})()`

/**
 * Read in the render host right after injecting the runtime: returns the snapshot of the
 * page state, or null if the runtime never ran.
 */
export const MOTION_SPEC = `(() => {
  const spec = window.__orbitMotionSpec
  return typeof spec === 'function' ? spec() : null
})()`

/** Host command to the iframe (same rules as the page's parseCommand). */
export type MotionHostCommand =
  | { type: 'seek'; frame: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'loop'; on: boolean }
  | { type: 'highlight'; index: number; name: string | null }

/** Iframe message to the host. */
export type MotionRuntimeMessage =
  | { type: 'ready'; durationInFrames: number; width: number; height: number; fps: number; version: number }
  | { type: 'time'; frame: number }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'assets'; failedFonts: string[] }

/** Validates a host→iframe command (same rules as the runtime on the page). */
export function parseMotionCommand(raw: unknown): MotionHostCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Record<string, unknown>
  if (msg.source !== MOTION_SOURCE) return null
  if (msg.type === 'seek') {
    return typeof msg.frame === 'number' && Number.isFinite(msg.frame)
      ? { type: 'seek', frame: Math.max(0, Math.round(msg.frame)) }
      : null
  }
  if (msg.type === 'play') return { type: 'play' }
  if (msg.type === 'pause') return { type: 'pause' }
  if (msg.type === 'loop') return { type: 'loop', on: Boolean(msg.on) }
  if (msg.type === 'highlight') {
    return {
      type: 'highlight',
      index: typeof msg.index === 'number' && Number.isFinite(msg.index) ? Math.round(msg.index) : -1,
      name: typeof msg.name === 'string' ? msg.name : null,
    }
  }
  return null
}

/** Validates an iframe→host message (ready/time/error/assets). */
export function parseMotionMessage(raw: unknown): MotionRuntimeMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Record<string, unknown>
  if (msg.source !== MOTION_SOURCE) return null
  if (msg.type === 'ready') {
    if (typeof msg.durationInFrames !== 'number' || !Number.isFinite(msg.durationInFrames)) return null
    return {
      type: 'ready',
      durationInFrames: Math.max(1, Math.round(msg.durationInFrames)),
      width: typeof msg.width === 'number' ? msg.width : 1920,
      height: typeof msg.height === 'number' ? msg.height : 1080,
      // An old piece (previous runtime) does not send fps: 30 is the contract default.
      fps: typeof msg.fps === 'number' && Number.isFinite(msg.fps) && msg.fps > 0 ? msg.fps : 30,
      version: typeof msg.version === 'number' ? msg.version : 0,
    }
  }
  if (msg.type === 'time') {
    return typeof msg.frame === 'number' && Number.isFinite(msg.frame)
      ? { type: 'time', frame: Math.max(0, Math.round(msg.frame)) }
      : null
  }
  if (msg.type === 'error') {
    if (typeof msg.message !== 'string') return null
    return { type: 'error', message: msg.message, stack: typeof msg.stack === 'string' ? msg.stack : undefined }
  }
  if (msg.type === 'assets') {
    const fonts = Array.isArray(msg.failedFonts) ? msg.failedFonts.filter((f): f is string => typeof f === 'string') : []
    return { type: 'assets', failedFonts: fonts }
  }
  return null
}

/** Mark of the injected `<script>`, so it is not duplicated in a composition already served. */
const RUNTIME_MARK = 'data-orbit-motion-runtime'

/** Runtime tag for the composition of `id` (the reserved `/__orbit-runtime.js`). */
export function motionRuntimeTag(scheme: string, id: string): string {
  return `<script ${RUNTIME_MARK} src="${scheme}://${id}${MOTION_RUNTIME_PATH}"></script>`
}

/**
 * Injects the runtime as the FIRST script of the `<head>` (as early as possible: the
 * composition runs afterwards and already counts on the API and on the delayRender capture).
 * Without `<head>`, the script is prefixed to the document — the parser executes it before
 * any script of the composition anyway.
 */
export function injectMotionRuntime(html: string, scheme: string, id: string, props?: Record<string, string | number | boolean> | null): string {
  if (html.includes(RUNTIME_MARK)) return html
  // The props of this render (props.json defaults + the overrides), then the runtime that exposes them,
  // then the import map for the native three.js (before any module script).
  const tag = (props ? propsScriptTag(props) : '') + motionRuntimeTag(scheme, id) + (hasOwnImportMap(html) ? '' : motionImportMapTag(scheme, id))
  const head = /<head[^>]*>/i.exec(html)
  if (head) return `${html.slice(0, head.index + head[0].length)}${tag}${html.slice(head.index + head[0].length)}`
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) return `${html.slice(0, htmlTag.index + htmlTag[0].length)}<head>${tag}</head>${html.slice(htmlTag.index + htmlTag[0].length)}`
  return tag + html
}
