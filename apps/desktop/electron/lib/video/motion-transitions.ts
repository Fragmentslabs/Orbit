/**
 * TRANSITIONS of a motion composition: the swap of one scene for another (or the
 * entrance/exit of a single one) as an act of the piece itself, and not as an animation
 * written by hand every time.
 *
 * The composition declares — `orbitMotion.transition({ out, in, at, duration, type })`
 * — and the runtime turns that into PAUSED Web Animations, one per
 * element. That is what makes them deterministic without new code in the frame path:
 * the runtime's `applyFrame` already positions EVERY `document.getAnimations()` at
 * `t * 1000`, so the transition is fetched exactly like a @keyframes — in the
 * preview, in the layer measurement and in the render. No timers, no state between
 * frames: the progress at `t` is a pure function of `t`.
 *
 * The animations only use properties that COMPOSE with what the composition already
 * wrote (`translate` and `scale` individually, which do not step on the `transform`;
 * `opacity`, `filter`, `clip-path`) and leave the element as it was outside the
 * interval: the entrance uses `fill: backwards` (hidden until `at`, released afterwards) and
 * the exit `fill: forwards` (hidden after the end).
 *
 * This module is only the BRAIN, in page JS: validating the request and assembling the
 * keyframes. The string is embedded in the runtime (which runs in the window, without importing) and
 * the tests execute it directly — no DOM is needed to check it.
 */

/** The transition types the runtime knows how to assemble. */
export const MOTION_TRANSITION_TYPES = ['fade', 'push', 'cover', 'reveal', 'wipe', 'zoom', 'blur', 'iris', 'cube', 'flip', 'door'] as const
export type MotionTransitionType = (typeof MOTION_TRANSITION_TYPES)[number]

/** Where the movement goes. `in`/`out` only apply to the zoom. */
export type MotionTransitionDirection = 'left' | 'right' | 'up' | 'down' | 'in' | 'out'

/** What the runtime announces about each registered transition (lint and report). */
export interface MotionTransitionInfo {
  type: MotionTransitionType
  direction: MotionTransitionDirection | null
  /** Second of the piece at which it starts. */
  at: number
  duration: number
  /** How the composition named each end (selector or label); null = absent. */
  out: string | null
  in: string | null
}

/**
 * The script. No backticks, no `${` and no backslash ON PURPOSE: it is
 * interpolated inside the runtime's template, where any of them would become
 * something else.
 */
export const MOTION_TRANSITIONS_SCRIPT = `
  const ORBIT_TRANSITION_TYPES = ${JSON.stringify(MOTION_TRANSITION_TYPES)}
  const ORBIT_TRANSITION_VECTORS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }
  // What is TOTALLY hidden in each wipe direction (clip-path insets):
  // the entrance starts like this, and the exit ends at the opposite side inset.
  const ORBIT_WIPE_HIDDEN = {
    left: '0% 0% 0% 100%',
    right: '0% 100% 0% 0%',
    up: '100% 0% 0% 0%',
    down: '0% 0% 100% 0%',
  }
  const ORBIT_WIPE_OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' }
  const ORBIT_EASING_WORDS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']

  function orbitValidEasing(value) {
    if (ORBIT_EASING_WORDS.indexOf(value) >= 0) return true
    const call = value.indexOf('cubic-bezier(') === 0 || value.indexOf('steps(') === 0
    return call && value.charAt(value.length - 1) === ')' && value.indexOf(';') < 0
  }

  // Validates the request and fills in the defaults. Returns { spec } or { error } — it never
  // throws: the caller decides whether the error takes the composition down.
  function orbitNormalizeTransition(raw) {
    if (!raw || typeof raw !== 'object') return { error: 'expected an object like { out, in, at, duration, type }' }
    if (!raw.out && !raw.in) return { error: 'give at least one of "out" (leaving) and "in" (entering)' }
    const type = raw.type === undefined ? 'fade' : String(raw.type)
    if (ORBIT_TRANSITION_TYPES.indexOf(type) < 0) {
      return { error: 'unknown type "' + type + '" (use ' + ORBIT_TRANSITION_TYPES.join(', ') + ')' }
    }
    // Fade, blur and iris have no side: the direction, if given, is ignored.
    let direction = null
    if (type === 'zoom') {
      direction = raw.direction === undefined ? 'in' : String(raw.direction)
      if (direction !== 'in' && direction !== 'out') return { error: 'zoom takes direction "in" or "out"' }
    } else if (type !== 'fade' && type !== 'blur' && type !== 'iris') {
      direction = raw.direction === undefined ? 'left' : String(raw.direction)
      if (!ORBIT_TRANSITION_VECTORS[direction]) {
        return { error: type + ' takes direction left, right, up or down (got "' + direction + '")' }
      }
    }
    if (typeof raw.at !== 'number' || !isFinite(raw.at) || raw.at < 0) {
      return { error: '"at" (the second the transition starts, >= 0) is required' }
    }
    const duration = raw.duration === undefined ? 0.6 : raw.duration
    if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0 || duration > 30) {
      return { error: '"duration" must be a number of seconds between 0 and 30' }
    }
    const easing = raw.easing === undefined ? 'ease-in-out' : String(raw.easing)
    if (!orbitValidEasing(easing)) {
      return { error: 'easing "' + easing + '" is not linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier(…) or steps(…)' }
    }
    let amount
    if (raw.amount !== undefined) {
      if (typeof raw.amount !== 'number' || !isFinite(raw.amount) || raw.amount <= 0) {
        return { error: '"amount" must be a positive number' }
      }
      amount = raw.amount
    }
    return { spec: { type: type, direction: direction, at: raw.at, duration: duration, easing: easing, amount: amount } }
  }

  // ---- the 3D ones (cube, flip, door): individual rotate + a perspective on the PARENT ----
  // Per direction: the axis a face turns about and the sign of the turn that sends it THAT way
  // (left: the face turns to look left, so the next one comes in from the right).
  const ORBIT_TURN = { left: ['Y', -1], right: ['Y', 1], up: ['X', 1], down: ['X', -1] }
  // The door is hinged on the side it opens toward: [transform-origin, axis, sign].
  const ORBIT_HINGE = { left: ['0% 50%', 'Y', -1], right: ['100% 50%', 'Y', 1], up: ['50% 0%', 'X', 1], down: ['50% 100%', 'X', -1] }
  // The size of the piece, as the runtime hands it over (a plain call without it still works).
  function orbitPieceSize(spec) { return spec.size || { w: 1920, h: 1080 } }
  // How strong the perspective is: amount (px) when given, else a multiple of the long side.
  function orbitPerspective(spec, factor) {
    if (spec.amount !== undefined) return Math.round(spec.amount)
    const size = orbitPieceSize(spec)
    return Math.round(Math.max(size.w, size.h) * factor)
  }

  // The perspective (px) the PARENT of the scenes needs while a 3D transition runs; 0 for the flat ones.
  // It lives on the parent so the scenes never need a transform of their own.
  function orbitTransitionPerspective(spec) {
    if (spec.type === 'cube') return orbitPerspective(spec, 1.3)
    if (spec.type === 'flip') return orbitPerspective(spec, 1.6)
    if (spec.type === 'door') return orbitPerspective(spec, 2)
    return 0
  }

  function orbitPct(n) { return (Math.round(n * 10000) / 100) + '%' }
  function orbitShift(x, y) { return orbitPct(x) + ' ' + orbitPct(y) }

  // The keyframes of each end: { out, in }. Visibility goes in EVERY end —
  // it is what hides the entrance until the start and the exit after the end, without touching what
  // the composition wrote for the element.
  function orbitTransitionKeyframes(spec) {
    const dir = spec.direction
    const v = ORBIT_TRANSITION_VECTORS[dir] || [0, 0]
    const rest = orbitShift(0, 0)
    const outShown = { visibility: 'visible' }
    const outGone = { visibility: 'hidden' }
    const inHidden = { visibility: 'hidden' }
    const inShown = { visibility: 'visible' }
    const mix = function (a, b) { return Object.assign({}, a, b) }
    switch (spec.type) {
      case 'push':
        return {
          out: [mix(outShown, { translate: rest }), mix(outGone, { translate: orbitShift(v[0], v[1]) })],
          in: [mix(inHidden, { translate: orbitShift(-v[0], -v[1]) }), mix(inShown, { translate: rest })],
        }
      case 'cover':
        // The entrance slides OVER an exit that hardly moves (a quarter
        // of the way: the depth). It requires the entrance to be above in the stacking.
        return {
          out: [mix(outShown, { translate: rest }), mix(outGone, { translate: orbitShift(v[0] * 0.25, v[1] * 0.25) })],
          in: [mix(inHidden, { translate: orbitShift(-v[0], -v[1]) }), mix(inShown, { translate: rest })],
        }
      case 'reveal':
        // The opposite: the exit slides out and uncovers an entrance that was already
        // down there. It requires the exit to be above.
        return {
          out: [mix(outShown, { translate: rest }), mix(outGone, { translate: orbitShift(v[0], v[1]) })],
          in: [mix(inHidden, { translate: orbitShift(-v[0] * 0.25, -v[1] * 0.25) }), mix(inShown, { translate: rest })],
        }
      case 'wipe': {
        // Both sides are clipped into COMPLEMENTARY parts, so the stacking
        // order does not matter: where the entrance shows up, the exit is already gone.
        const full = 'inset(0% 0% 0% 0%)'
        return {
          out: [
            mix(outShown, { clipPath: full }),
            mix(outGone, { clipPath: 'inset(' + ORBIT_WIPE_HIDDEN[ORBIT_WIPE_OPPOSITE[dir]] + ')' }),
          ],
          in: [mix(inHidden, { clipPath: 'inset(' + ORBIT_WIPE_HIDDEN[dir] + ')' }), mix(inShown, { clipPath: full })],
        }
      }
      case 'zoom': {
        const a = Math.min(spec.amount === undefined ? 0.25 : spec.amount, 1)
        const grow = 1 + a
        const shrink = 1 - a * 0.8
        const zoomIn = dir !== 'out'
        return {
          out: [
            mix(outShown, { scale: '1', opacity: '1' }),
            mix(outGone, { scale: String(zoomIn ? grow : shrink), opacity: '0' }),
          ],
          in: [
            mix(inHidden, { scale: String(zoomIn ? shrink : grow), opacity: '0' }),
            mix(inShown, { scale: '1', opacity: '1' }),
          ],
        }
      }
      case 'blur': {
        const px = (spec.amount === undefined ? 24 : spec.amount) + 'px'
        return {
          out: [mix(outShown, { filter: 'blur(0px)', opacity: '1' }), mix(outGone, { filter: 'blur(' + px + ')', opacity: '0' })],
          in: [mix(inHidden, { filter: 'blur(' + px + ')', opacity: '0' }), mix(inShown, { filter: 'blur(0px)', opacity: '1' })],
        }
      }
      case 'iris':
        // 75% of the reference radius covers the farthest corner of any
        // aspect ratio. The exit only vanishes at the end: the entrance, above, keeps covering it.
        return {
          out: [outShown, outGone],
          in: [
            mix(inHidden, { clipPath: 'circle(0% at 50% 50%)' }),
            mix(inShown, { clipPath: 'circle(75% at 50% 50%)' }),
          ],
        }
      case 'cube': {
        // The two scenes are two faces of a cube that turns: the face leaving looks away while the next
        // one comes round, the far one darkening a little for depth. The pivot is the axis of the cube,
        // half a scene BEHIND the screen (a 3-value transform-origin), so only the rotate property is needed.
        const turn = ORBIT_TURN[dir]
        const size = orbitPieceSize(spec)
        const depth = Math.round((turn[0] === 'Y' ? size.w : size.h) / 2)
        const pivot = { transformOrigin: '50% 50% -' + depth + 'px' }
        const face = function (deg) { return turn[0].toLowerCase() + ' ' + deg + 'deg' }
        return {
          out: [mix(outShown, mix(pivot, { rotate: face(0), filter: 'brightness(1)' })), mix(outGone, mix(pivot, { rotate: face(90 * turn[1]), filter: 'brightness(0.55)' }))],
          in: [mix(inHidden, mix(pivot, { rotate: face(-90 * turn[1]), filter: 'brightness(0.55)' })), mix(inShown, mix(pivot, { rotate: face(0), filter: 'brightness(1)' }))],
        }
      }
      case 'flip': {
        // One card turned over: both scenes turn a half-turn together, the leaving one as the front and
        // the entering one as the back. backface-visibility hides each face once it looks away, so the
        // swap happens by itself at the midpoint (when both are edge-on).
        const turn = ORBIT_TURN[dir]
        const spin = function (deg) { return turn[0].toLowerCase() + ' ' + deg + 'deg' }
        const card = { transformOrigin: '50% 50%', backfaceVisibility: 'hidden' }
        return {
          out: [mix(outShown, mix(card, { rotate: spin(0) })), mix(outGone, mix(card, { rotate: spin(180 * turn[1]) }))],
          in: [mix(inHidden, mix(card, { rotate: spin(-180 * turn[1]) })), mix(inShown, mix(card, { rotate: spin(0) }))],
        }
      }
      case 'door': {
        // The leaving scene swings open on a hinge, toward the viewer, and uncovers the entering one
        // that was waiting behind it. It needs the leaving scene ABOVE the other in the stacking.
        const hinge = ORBIT_HINGE[dir]
        const swing = function (deg) { return hinge[1].toLowerCase() + ' ' + deg + 'deg' }
        const origin = { transformOrigin: hinge[0] }
        return {
          out: [mix(outShown, mix(origin, { rotate: swing(0), filter: 'brightness(1)' })), mix(outGone, mix(origin, { rotate: swing(90 * hinge[2]), filter: 'brightness(0.6)' }))],
          in: [mix(inHidden, { scale: '0.92', filter: 'brightness(0.6)' }), mix(inShown, { scale: '1', filter: 'brightness(1)' })],
        }
      }
      default:
        return {
          out: [mix(outShown, { opacity: '1' }), mix(outGone, { opacity: '0' })],
          in: [mix(inHidden, { opacity: '0' }), mix(inShown, { opacity: '1' })],
        }
    }
  }
`

/** Shape the script returns — the same one the tests and the lint expect. */
export interface NormalizedTransition {
  type: MotionTransitionType
  direction: MotionTransitionDirection | null
  at: number
  duration: number
  easing: string
  amount?: number
  /** The piece's size in px, handed over by the runtime (the 3D types need the depth of a cube). */
  size?: { w: number; h: number }
}

/** One line per transition for the report the agent reads (time of the PIECE, in seconds). */
export function describeTransitions(transitions: MotionTransitionInfo[]): string {
  if (transitions.length === 0) return ''
  const sec = (n: number) => `${Number(n.toFixed(2))}s`
  return `Transitions: ${transitions
    .map((t) => {
      const side = [t.out ? `out ${t.out}` : '', t.in ? `in ${t.in}` : ''].filter(Boolean).join(', ')
      return `${t.type}${t.direction ? ` ${t.direction}` : ''} ${sec(t.at)}→${sec(t.at + t.duration)} (${side})`
    })
    .join('; ')}.`
}
