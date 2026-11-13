import { describe, expect, it } from 'vitest'
import { DESIGN_RUNTIME } from './design-runtime'

describe('design runtime (the bridge injected into each artboard)', () => {
  it('is a syntactically valid script', () => {
    // The bridge is a template literal full of hand-written JavaScript: one stray character would
    // silently kill selection in every artboard, so the syntax is checked here.
    expect(() => new Function(DESIGN_RUNTIME)).not.toThrow()
  })

  it('speaks the messages the panel listens for (cross-artboard drag and loose pieces)', () => {
    for (const word of ["'crossDrag'", "'boardDrag'", "'dropTarget'", "'dropAt'", "'dragAbort'", "'size'", 'data-orbit-free']) {
      expect(DESIGN_RUNTIME).toContain(word)
    }
  })
})
