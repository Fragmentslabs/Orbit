import { describe, expect, it } from 'vitest'
import { MOTION_RUNTIME } from './motion-runtime'
import { MOTION_TRANSITIONS_SCRIPT, MOTION_TRANSITION_TYPES, type NormalizedTransition } from './motion-transitions'

type Frames = Array<Record<string, string>>
interface Plan {
  out: Frames
  in: Frames
}

// The script is page JS: here it runs as a pure function, without a DOM.
const { normalize, keyframes, perspective } = new Function(
  `${MOTION_TRANSITIONS_SCRIPT}; return { normalize: orbitNormalizeTransition, keyframes: orbitTransitionKeyframes, perspective: orbitTransitionPerspective }`,
)() as {
  normalize(raw: unknown): { spec?: NormalizedTransition; error?: string }
  keyframes(spec: NormalizedTransition): Plan
  perspective(spec: NormalizedTransition): number
}

const ok = (raw: Record<string, unknown>): NormalizedTransition => {
  const result = normalize({ out: '.a', in: '.b', at: 1, ...raw })
  expect(result.error).toBeUndefined()
  return result.spec as NormalizedTransition
}

describe('normalize', () => {
  it('fills the defaults: a 0.6 s ease-in-out fade', () => {
    expect(ok({})).toEqual({
      type: 'fade',
      direction: null,
      at: 1,
      duration: 0.6,
      easing: 'ease-in-out',
      amount: undefined,
    })
  })

  it('needs a start time and at least one side', () => {
    expect(normalize({ out: '.a', in: '.b' }).error).toMatch(/"at"/)
    expect(normalize({ out: '.a', in: '.b', at: -1 }).error).toMatch(/"at"/)
    expect(normalize({ at: 1 }).error).toMatch(/at least one/)
    expect(normalize(null).error).toMatch(/expected an object/)
  })

  it('an entrance alone or an exit alone is a transition too', () => {
    expect(normalize({ in: '.title', at: 0, type: 'blur' }).error).toBeUndefined()
    expect(normalize({ out: '.title', at: 3 }).error).toBeUndefined()
  })

  it('refuses a type it does not know, naming the ones it does', () => {
    const { error } = normalize({ out: '.a', at: 0, type: 'spin' })
    expect(error).toMatch(/unknown type "spin"/)
    for (const type of MOTION_TRANSITION_TYPES) expect(error).toContain(type)
  })

  it('directions: left/right/up/down for the slides and wipes, in/out for the zoom', () => {
    expect(ok({ type: 'push' }).direction).toBe('left')
    expect(ok({ type: 'wipe', direction: 'down' }).direction).toBe('down')
    expect(ok({ type: 'zoom' }).direction).toBe('in')
    expect(ok({ type: 'zoom', direction: 'out' }).direction).toBe('out')
    expect(normalize({ out: '.a', at: 0, type: 'push', direction: 'in' }).error).toMatch(/left, right, up or down/)
    expect(normalize({ out: '.a', at: 0, type: 'zoom', direction: 'left' }).error).toMatch(/"in" or "out"/)
    // Without a side: the direction is ignored, it is not an error.
    expect(ok({ type: 'fade', direction: 'left' }).direction).toBeNull()
  })

  it('checks duration, easing and amount', () => {
    expect(normalize({ out: '.a', at: 0, duration: 0 }).error).toMatch(/duration/)
    expect(normalize({ out: '.a', at: 0, duration: 31 }).error).toMatch(/duration/)
    expect(normalize({ out: '.a', at: 0, easing: 'bounce' }).error).toMatch(/easing/)
    expect(normalize({ out: '.a', at: 0, easing: 'cubic-bezier(0.2, 0, 0, 1)' }).error).toBeUndefined()
    expect(normalize({ out: '.a', at: 0, amount: -2 }).error).toMatch(/amount/)
  })
})

describe('keyframes', () => {
  const both = (frames: Frames) => frames.map((f) => f.visibility)

  it('every side hides the entrance until it starts and the exit after it ends', () => {
    for (const type of MOTION_TRANSITION_TYPES) {
      const plan = keyframes(ok({ type }))
      expect(both(plan.in), type).toEqual(['hidden', 'visible'])
      expect(both(plan.out), type).toEqual(['visible', 'hidden'])
    }
  })

  it('push moves both pieces the same way, one length behind the other', () => {
    const plan = keyframes(ok({ type: 'push', direction: 'left' }))
    expect(plan.out.map((f) => f.translate)).toEqual(['0% 0%', '-100% 0%'])
    expect(plan.in.map((f) => f.translate)).toEqual(['100% 0%', '0% 0%'])
    const down = keyframes(ok({ type: 'push', direction: 'down' }))
    expect(down.out[1].translate).toBe('0% 100%')
    expect(down.in[0].translate).toBe('0% -100%')
  })

  it('cover and reveal only move one of the two pieces all the way', () => {
    const cover = keyframes(ok({ type: 'cover', direction: 'right' }))
    expect(cover.in[0].translate).toBe('-100% 0%')
    expect(cover.out[1].translate).toBe('25% 0%')
    const reveal = keyframes(ok({ type: 'reveal', direction: 'right' }))
    expect(reveal.out[1].translate).toBe('100% 0%')
    expect(reveal.in[0].translate).toBe('-25% 0%')
  })

  it('wipe cuts the two pieces into complementary parts, so stacking order does not matter', () => {
    const plan = keyframes(ok({ type: 'wipe', direction: 'left' }))
    expect(plan.in.map((f) => f.clipPath)).toEqual(['inset(0% 0% 0% 100%)', 'inset(0% 0% 0% 0%)'])
    // What the entrance does not occupy yet is exactly what the exit still occupies.
    expect(plan.out.map((f) => f.clipPath)).toEqual(['inset(0% 0% 0% 0%)', 'inset(0% 100% 0% 0%)'])
  })

  it('zoom in grows the exit and settles the entrance from smaller; zoom out is the mirror', () => {
    const zoomIn = keyframes(ok({ type: 'zoom' }))
    expect(zoomIn.out[1].scale).toBe('1.25')
    expect(zoomIn.in[0].scale).toBe('0.8')
    const zoomOut = keyframes(ok({ type: 'zoom', direction: 'out', amount: 0.5 }))
    expect(zoomOut.out[1].scale).toBe('0.6')
    expect(zoomOut.in[0].scale).toBe('1.5')
  })

  it('blur defaults to 24 px and takes the amount', () => {
    expect(keyframes(ok({ type: 'blur' })).in[0].filter).toBe('blur(24px)')
    expect(keyframes(ok({ type: 'blur', amount: 8 })).out[1].filter).toBe('blur(8px)')
  })

  it('iris opens a circle from the centre, past the farthest corner', () => {
    const plan = keyframes(ok({ type: 'iris' }))
    expect(plan.in.map((f) => f.clipPath)).toEqual(['circle(0% at 50% 50%)', 'circle(75% at 50% 50%)'])
  })

  it('never writes `transform`, which would trample what the composition set', () => {
    for (const type of MOTION_TRANSITION_TYPES) {
      const plan = keyframes(ok({ type }))
      for (const frame of [...plan.out, ...plan.in]) expect(Object.keys(frame), type).not.toContain('transform')
    }
  })
})

describe('3D: cube, flip, door', () => {
  const sized = (raw: Record<string, unknown>, w = 1920, h = 1080): NormalizedTransition => ({ ...ok(raw), size: { w, h } })

  it('they take a direction, left by default', () => {
    for (const type of ['cube', 'flip', 'door']) expect(ok({ type }).direction).toBe('left')
    expect(normalize({ out: '.a', at: 0, type: 'cube', direction: 'in' }).error).toMatch(/left, right, up or down/)
  })

  it('cube turns about the axis half a scene behind the screen, the leaving face one way and the entering one from the other', () => {
    const left = keyframes(sized({ type: 'cube', direction: 'left' }))
    expect(left.out.map((f) => f.rotate)).toEqual(['y 0deg', 'y -90deg'])
    expect(left.in.map((f) => f.rotate)).toEqual(['y 90deg', 'y 0deg'])
    expect(left.out[0].transformOrigin).toBe('50% 50% -960px') // half the width of 1920
    expect(keyframes(sized({ type: 'cube', direction: 'right' })).out[1].rotate).toBe('y 90deg')
    const up = keyframes(sized({ type: 'cube', direction: 'up' }))
    expect(up.out[1].rotate).toBe('x 90deg')
    expect(up.out[0].transformOrigin).toBe('50% 50% -540px') // half the HEIGHT of 1080: up and down turn about X
    expect(keyframes(sized({ type: 'cube', direction: 'down' })).out[1].rotate).toBe('x -90deg')
  })

  it('cube depth follows the size of the piece, and darkens the far face', () => {
    const portrait = keyframes(sized({ type: 'cube' }, 1080, 1920))
    expect(portrait.in[0].transformOrigin).toBe('50% 50% -540px')
    expect(portrait.in[0].filter).toBe('brightness(0.55)')
    expect(portrait.in[1].filter).toBe('brightness(1)')
  })

  it('flip turns both sides a half-turn and lets backface-visibility swap them at the middle', () => {
    const plan = keyframes(sized({ type: 'flip', direction: 'left' }))
    expect(plan.out.map((f) => f.rotate)).toEqual(['y 0deg', 'y -180deg'])
    expect(plan.in.map((f) => f.rotate)).toEqual(['y 180deg', 'y 0deg'])
    for (const f of [...plan.out, ...plan.in]) expect(f.backfaceVisibility).toBe('hidden')
  })

  it('door swings on the hinge of the side it opens toward, the entering scene grows into place', () => {
    const origins = { left: '0% 50%', right: '100% 50%', up: '50% 0%', down: '50% 100%' } as const
    const angles = { left: 'y -90deg', right: 'y 90deg', up: 'x 90deg', down: 'x -90deg' } as const
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      const plan = keyframes(sized({ type: 'door', direction: dir }))
      expect(plan.out[0].transformOrigin, dir).toBe(origins[dir])
      expect(plan.out[1].rotate, dir).toBe(angles[dir])
    }
    const plan = keyframes(sized({ type: 'door' }))
    expect(plan.in.map((f) => f.scale)).toEqual(['0.92', '1'])
  })

  it('works without a size (a plain call) with a 1920×1080 default', () => {
    expect(keyframes(ok({ type: 'cube' })).out[0].transformOrigin).toBe('50% 50% -960px')
  })

  it('the perspective belongs to the parent: stronger for the door, overridable with amount, zero for the flat ones', () => {
    expect(perspectiveOf({ type: 'cube' })).toBe(Math.round(1920 * 1.3))
    expect(perspectiveOf({ type: 'flip' })).toBe(Math.round(1920 * 1.6))
    expect(perspectiveOf({ type: 'door' })).toBe(1920 * 2)
    expect(perspectiveOf({ type: 'cube', amount: 800 })).toBe(800)
    for (const type of ['fade', 'push', 'cover', 'reveal', 'wipe', 'zoom', 'blur', 'iris']) expect(perspectiveOf({ type }), type).toBe(0)
  })

  function perspectiveOf(raw: Record<string, unknown>): number {
    return perspective(sized(raw))
  }
})

describe('runtime', () => {
  it('embeds the script and exposes orbitMotion.transition', () => {
    expect(() => new Function(MOTION_RUNTIME)).not.toThrow()
    expect(MOTION_RUNTIME).toContain('orbitNormalizeTransition')
    expect(MOTION_RUNTIME).toContain('api.transition = addTransition')
  })
})
