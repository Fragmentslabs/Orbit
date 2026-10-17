import { describe, expect, it } from 'vitest'
import { MOTION_RUNTIME } from './motion-runtime'
import { MOTION_TRANSITIONS_SCRIPT, MOTION_TRANSITION_TYPES, type NormalizedTransition } from './motion-transitions'

type Frames = Array<Record<string, string>>
interface Plan {
  out: Frames
  in: Frames
}

// O script é JS de página: aqui ele roda como função pura, sem DOM.
const { normalize, keyframes } = new Function(
  `${MOTION_TRANSITIONS_SCRIPT}; return { normalize: orbitNormalizeTransition, keyframes: orbitTransitionKeyframes }`,
)() as {
  normalize(raw: unknown): { spec?: NormalizedTransition; error?: string }
  keyframes(spec: NormalizedTransition): Plan
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
    // Sem lado: a direção é ignorada, não é erro.
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
    // O que a entrada ainda não ocupa é exatamente o que a saída ainda ocupa.
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

describe('runtime', () => {
  it('embeds the script and exposes orbitMotion.transition', () => {
    expect(() => new Function(MOTION_RUNTIME)).not.toThrow()
    expect(MOTION_RUNTIME).toContain('orbitNormalizeTransition')
    expect(MOTION_RUNTIME).toContain('api.transition = addTransition')
  })
})
