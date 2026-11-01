/**
 * `orbit-three`: the module that makes a three.js piece a pure function of the frame.
 *
 * The composition imports it (`import { mountThree } from 'orbit-three'`) and writes only what is
 * ITS part: build the world once (`setup`) and say what moves with t (`update`). The helper owns
 * everything that breaks determinism or the render when done by hand: the renderer defaults
 * (no MSAA, pixel ratio 1, fixed size), the seek, the shader warm-up, the loading handles,
 * the seeded generator and a camera rig made of SHOTS (so a piece is a sequence of planes, not
 * one static camera). It is plain JavaScript served as text, so it has no build step.
 */
export const MOTION_THREE_HELPER_PATH = 'orbit-three.js'

export const MOTION_THREE_HELPER = `
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

// ---------------------------------------------------------------- helpers
export function rng(seed) {                       // mulberry32: same seed, same sequence
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const clamp01 = (u) => Math.min(1, Math.max(0, u))
export const ease = {
  linear: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
  inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  back: (u) => { const c = 1.70158; const x = u - 1; return 1 + (c + 1) * x * x * x + c * x * x },
}
const isRange = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'from' in v && 'to' in v
const lerp = (a, b, u) => a + (b - a) * u
function pick(v, u) {                              // number | [x,y,z] | { from, to }
  if (isRange(v)) {
    if (Array.isArray(v.from)) return v.from.map((n, i) => lerp(n, v.to[i], u))
    return lerp(v.from, v.to, u)
  }
  return v
}

// ------------------------------------------------------------- the camera rig
// A shot: { from, to } (frames) + one of
//   pos / look / fov  — each a value or { from, to }
//   orbit: { center, radius, height, angle }  — radius/height/angle are a value or { from, to } (angle in radians)
// plus ease ('inOut' default), drift (metres of a slow deterministic sway, default 0).
export function applyShot(camera, shots, frame, fps) {
  if (!shots || !shots.length) return -1
  let index = shots.findIndex((s) => frame >= s.from && frame < s.to)
  if (index === -1) index = frame < shots[0].from ? 0 : shots.length - 1
  const shot = shots[index]
  const span = Math.max(1, shot.to - shot.from)
  const u = (ease[shot.ease || 'inOut'] || ease.inOut)(clamp01((frame - shot.from) / span))
  let pos, look
  if (shot.orbit) {
    const o = shot.orbit
    const angle = pick(o.angle, u), radius = pick(o.radius, u), height = pick(o.height, u)
    const c = o.center || [0, 0, 0]
    pos = [c[0] + Math.sin(angle) * radius, c[1] + height, c[2] + Math.cos(angle) * radius]
    look = c
  } else {
    pos = pick(shot.pos, u)
    look = pick(shot.look || [0, 0, 0], u)
  }
  const t = frame / fps
  const d = shot.drift || 0
  camera.position.set(pos[0] + Math.sin(t * 0.9) * d, pos[1] + Math.cos(t * 0.7) * d * 0.6, pos[2] + Math.sin(t * 0.5) * d)
  camera.lookAt(look[0], look[1], look[2])
  const fov = pick(shot.fov === undefined ? camera.fov : shot.fov, u)
  if (fov !== camera.fov) { camera.fov = fov; camera.updateProjectionMatrix() }
  return index
}

// -------------------------------------------------------------------- mount
export function mountThree(opts) {
  const rt = window.orbitMotion || {}
  const width = opts.width || rt.width || 1920
  const height = opts.height || rt.height || 1080
  const fps = opts.fps || rt.fps || 30
  const frames = opts.durationInFrames || rt.durationInFrames

  // Software render: no MSAA, no devicePixelRatio. Hard-coded on purpose.
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: opts.background === null, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1)
  renderer.setSize(width, height)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = opts.toneMapping === 'none' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = opts.exposure || 1
  if (opts.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap }
  renderer.domElement.style.display = 'block'
  document.body.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  if (opts.background !== null && opts.background !== undefined) scene.background = new THREE.Color(opts.background)
  if (opts.fog) scene.fog = new THREE.Fog(opts.fog.color || opts.background || '#000000', opts.fog.near, opts.fog.far)
  if (opts.environment !== false) {
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
    if (opts.environmentIntensity !== undefined) scene.environmentIntensity = opts.environmentIntensity
  }
  const camera = new THREE.PerspectiveCamera(opts.fov || 40, width / height, opts.near || 0.5, opts.far || 200)

  // Asynchronous work (GLTFLoader, textures): the seek waits for it.
  const ctx = { THREE, scene, camera, renderer, width, height, fps, rng, ease, shot: 0, u: 0 }
  ctx.wait = function (promise) {
    const handle = window.orbitMotion.delayRender && window.orbitMotion.delayRender()
    return Promise.resolve(promise).finally(function () {
      if (handle !== undefined && window.orbitMotion.continueRender) window.orbitMotion.continueRender(handle)
    })
  }

  const built = opts.setup ? opts.setup(ctx) : undefined
  if (built && typeof built.then === 'function') ctx.wait(built)
  ctx.state = built && typeof built.then !== 'function' ? built : undefined
  renderer.compile(scene, camera)

  function draw(frame) {
    const t = frame / fps
    ctx.shot = applyShot(camera, opts.shots, frame, fps)
    if (opts.update) opts.update(t, frame, ctx)
    renderer.render(scene, camera)
  }
  const api = { width, height, fps, seek: draw }
  if (frames) api.durationInFrames = frames
  window.orbitMotion = api
  return ctx
}
`
