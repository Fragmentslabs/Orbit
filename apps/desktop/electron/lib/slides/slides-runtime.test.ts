import { describe, expect, it } from 'vitest'
import { SLIDES_RUNTIME, SLIDES_RUNTIME_PATH, SLIDES_SOURCE, injectSlidesRuntime } from './slides-runtime'

/**
 * O runtime é uma STRING que roda dentro do deck. Um erro de sintaxe aqui não
 * aparece em nenhum typecheck: o deck serve a página, o script não executa e o
 * palco nasce vazio. Por isso o teste compila o texto.
 */
describe('SLIDES_RUNTIME', () => {
  it('é JavaScript válido', () => {
    expect(() => new Function(SLIDES_RUNTIME)).not.toThrow()
  })

  it('traz o contrato da ponte e o defer do DOM', () => {
    expect(SLIDES_RUNTIME).toContain(SLIDES_SOURCE)
    expect(SLIDES_RUNTIME).toContain("type: 'ready'")
    expect(SLIDES_RUNTIME).toContain("type: 'change'")
    expect(SLIDES_RUNTIME).toContain('DOMContentLoaded')
    // O script é o primeiro do <head>: sem o defer, não há slides no DOM.
    expect(SLIDES_RUNTIME).toContain("if (document.readyState === 'loading')")
  })

  it('monta o palco com o tamanho declarado e centraliza por translate', () => {
    expect(SLIDES_RUNTIME).toContain('orbit-slides-stage')
    expect(SLIDES_RUNTIME).toContain('translate(-50%, -50%) scale(')
    expect(SLIDES_RUNTIME).toContain('ResizeObserver')
  })

  it('não carrega template literal (a string é montada por concatenação)', () => {
    expect(SLIDES_RUNTIME.includes('`')).toBe(false)
  })
})

describe('injectSlidesRuntime', () => {
  it('uma vez só, e aponta para o caminho reservado', () => {
    const html = '<!doctype html><html><head></head><body><section class="slide">x</section></body></html>'
    const out = injectSlidesRuntime(html)
    expect(out).toContain(SLIDES_RUNTIME_PATH)
    expect(injectSlidesRuntime(out)).toBe(out)
  })
})
