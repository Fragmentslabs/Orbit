import { describe, expect, it } from 'vitest'
import { SLIDES_RUNTIME, SLIDES_RUNTIME_PATH, SLIDES_SOURCE, injectSlidesRuntime } from './slides-runtime'

/**
 * The runtime is a STRING that runs inside the deck. A syntax error here does not
 * show up in any typecheck: the deck serves the page, the script does not execute and
 * the stage is born empty. That is why the test compiles the text.
 */
describe('SLIDES_RUNTIME', () => {
  it('is valid JavaScript', () => {
    expect(() => new Function(SLIDES_RUNTIME)).not.toThrow()
  })

  it('traz o contrato da ponte e o defer do DOM', () => {
    expect(SLIDES_RUNTIME).toContain(SLIDES_SOURCE)
    expect(SLIDES_RUNTIME).toContain("type: 'ready'")
    expect(SLIDES_RUNTIME).toContain("type: 'change'")
    expect(SLIDES_RUNTIME).toContain('DOMContentLoaded')
    // The script is the first one in the <head>: without defer, there are no slides in the DOM.
    expect(SLIDES_RUNTIME).toContain("if (document.readyState === 'loading')")
  })

  it('builds the stage at the declared size and centers it with translate', () => {
    expect(SLIDES_RUNTIME).toContain('orbit-slides-stage')
    expect(SLIDES_RUNTIME).toContain('translate(-50%, -50%) scale(')
    expect(SLIDES_RUNTIME).toContain('ResizeObserver')
  })

  it('does not load a template literal (the string is built by concatenation)', () => {
    expect(SLIDES_RUNTIME.includes('`')).toBe(false)
  })
})

describe('injectSlidesRuntime', () => {
  it('only once, and points at the reserved path', () => {
    const html = '<!doctype html><html><head></head><body><section class="slide">x</section></body></html>'
    const out = injectSlidesRuntime(html)
    expect(out).toContain(SLIDES_RUNTIME_PATH)
    expect(injectSlidesRuntime(out)).toBe(out)
  })
})
