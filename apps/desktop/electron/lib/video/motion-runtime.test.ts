import { describe, expect, it, vi } from 'vitest'
import {
  MOTION_FPS,
  MOTION_RUNTIME,
  MOTION_RUNTIME_PATH,
  MOTION_SOURCE,
  injectMotionRuntime,
  motionRuntimeTag,
  parseMotionCommand,
  parseMotionMessage,
} from './motion-runtime'

const TAG = motionRuntimeTag('orbit-motion', 'mv_abc')

describe('MOTION_RUNTIME', () => {
  it('is valid JavaScript and carries the frozen frame contract', () => {
    // Compila o texto: um erro de sintaxe na string só apareceria na janela de
    // render, com o usuário esperando o vídeo.
    expect(() => new Function(MOTION_RUNTIME)).not.toThrow()
    expect(MOTION_RUNTIME).toContain(`const FPS = ${MOTION_FPS}`)
    expect(MOTION_RUNTIME).toContain('window.orbitMotion')
    expect(MOTION_RUNTIME).toContain('delayRender')
    expect(MOTION_RUNTIME).toContain('postMessage')
    // Quadro inteiro: o seek converte por fps.
    expect(MOTION_RUNTIME).toContain('frame / resolved.fps')
  })
})

describe('parseMotionCommand (host → iframe)', () => {
  it('accepts the four commands and normalizes the frame', () => {
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: 7.6 })).toEqual({ type: 'seek', frame: 8 })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: -3 })).toEqual({ type: 'seek', frame: 0 })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'play' })).toEqual({ type: 'play' })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'pause' })).toEqual({ type: 'pause' })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'loop', on: true })).toEqual({ type: 'loop', on: true })
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'loop', on: false })).toEqual({ type: 'loop', on: false })
  })

  it('rejects anything that is not one of ours', () => {
    expect(parseMotionCommand(null)).toBeNull()
    expect(parseMotionCommand('seek')).toBeNull()
    expect(parseMotionCommand({ type: 'seek', frame: 1 })).toBeNull() // sem source
    expect(parseMotionCommand({ source: 'chat', type: 'seek', frame: 1 })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek' })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: Number.NaN })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'seek', frame: '3' })).toBeNull()
    expect(parseMotionCommand({ source: MOTION_SOURCE, type: 'ready', durationInFrames: 10 })).toBeNull() // é do outro lado
  })
})

describe('parseMotionMessage (iframe → host)', () => {
  it('accepts ready/time/error/assets', () => {
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'ready', durationInFrames: 120.4, width: 1920, height: 1080, version: 1 })).toEqual({
      type: 'ready',
      durationInFrames: 120,
      width: 1920,
      height: 1080,
      version: 1,
    })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'time', frame: 12.9 })).toEqual({ type: 'time', frame: 13 })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'error', message: 'boom', stack: 'at x' })).toEqual({
      type: 'error',
      message: 'boom',
      stack: 'at x',
    })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'assets', failedFonts: ['Inter', 7, 'Geist'] })).toEqual({
      type: 'assets',
      failedFonts: ['Inter', 'Geist'],
    })
  })

  it('falls back to sensible defaults and rejects malformed messages', () => {
    const ready = parseMotionMessage({ source: MOTION_SOURCE, type: 'ready', durationInFrames: 90 })
    expect(ready).toEqual({ type: 'ready', durationInFrames: 90, width: 1920, height: 1080, version: 0 })
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'ready' })).toBeNull()
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'error', message: 42 })).toBeNull()
    expect(parseMotionMessage({ source: MOTION_SOURCE, type: 'seek', frame: 1 })).toBeNull() // é do outro lado
    expect(parseMotionMessage({ source: 'chat', type: 'time', frame: 1 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// O runtime roda NA página. Aqui ele roda contra uma página falsa mínima, para
// travar o que só apareceria numa janela de verdade: o quadro inteiro, a espera
// do delayRender e o descarte de seeks velhos.
// ---------------------------------------------------------------------------

interface FakeApi {
  seek(frame: number): Promise<void>
  delayRender(): number
  continueRender(handle: number): void
  durationInFrames?: number
  width?: number
  height?: number
  fps?: number
  version?: number
  failedFonts?: string[]
}

type FakeEvent = { data?: unknown; source?: unknown }
type FakeListener = (event: FakeEvent) => void

const tick = (times = 3) =>
  (async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })()

function makePage(
  options: { meta?: string | null; predeclared?: Record<string, unknown>; manual?: boolean } = {},
) {
  const posted: Array<Record<string, unknown>> = []
  const writes: number[] = []
  const animation = {
    _t: 0,
    pause() {},
    get currentTime() {
      return this._t
    },
    set currentTime(value: number) {
      writes.push(value)
      this._t = value
    },
  }
  const listeners: FakeListener[] = []
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) }
  const win = {
    devicePixelRatio: 2,
    parent,
    orbitMotion: (options.predeclared ?? {}) as Record<string, unknown>,
    addEventListener: (type: string, fn: FakeListener) => {
      if (type === 'message') listeners.push(fn)
    },
  }
  const doc = {
    readyState: 'complete',
    documentElement: { style: {} as Record<string, string>, getBoundingClientRect: () => ({ height: 1080 }) },
    querySelector: (selector: string) =>
      options.meta && selector.includes('orbit-motion') ? { getAttribute: () => options.meta } : null,
    querySelectorAll: () => [] as unknown[],
    getAnimations: () => [animation],
    fonts: Object.assign([] as unknown[], { ready: Promise.resolve() }),
  }
  // O play é um laço de rAF com o relógio de performance: para olhar quadro a
  // quadro, o teste controla os dois. No modo `manual` os callbacks ficam numa
  // fila que o teste esvazia e o relógio é o `clock`.
  const clock = { t: 0 }
  const queue: Array<() => void> = []
  const raf = options.manual
    ? (fn: () => void) => queue.push(fn)
    : (fn: () => void) => setTimeout(fn, 0) as unknown as number
  const caf = (id: number) => {
    if (!options.manual) clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
  }
  new Function(
    'window',
    'document',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'performance',
    'setTimeout',
    'clearTimeout',
    MOTION_RUNTIME,
  )(win, doc, raf, caf, { now: () => clock.t }, setTimeout, clearTimeout)

  return { win, parent, posted, writes, animation, listeners, clock, queue, api: win.orbitMotion as unknown as FakeApi }
}

type FakePage = ReturnType<typeof makePage>

/** Comando do host, como o runtime o recebe (mesma ponte do preview). */
function send(page: FakePage, type: string, extra: Record<string, unknown> = {}): void {
  page.listeners[0]({ data: { source: MOTION_SOURCE, type, ...extra }, source: page.parent })
}

/** Quadros que o play mandou pintar, na ordem. */
function timeFrames(page: FakePage): number[] {
  return page.posted.filter((m) => m.type === 'time').map((m) => m.frame as number)
}

/**
 * Um passo do play com o relógio controlado: o relógio anda `ms` e os callbacks
 * de rAF pendentes rodam até um quadro novo ser pintado (é o que o lote de rAF
 * do runtime faz, contando com os do nextFrame do seek).
 */
async function step(page: FakePage, ms: number): Promise<void> {
  const before = timeFrames(page).length
  page.clock.t += ms
  for (let i = 0; i < 20; i++) {
    const fn = page.queue.shift()
    if (!fn) break
    fn()
    await tick(1)
    if (timeFrames(page).length > before) return
  }
}

describe('MOTION_RUNTIME na página', () => {
  it('anuncia o ready em QUADROS e o formato resolvido', () => {
    const { api, posted } = makePage({ meta: 'width=1080,height=1920,fps=30,duration=3' })
    expect(api.version).toBe(1)
    expect(api.width).toBe(1080)
    expect(api.height).toBe(1920)
    expect(api.durationInFrames).toBe(90)
    expect(posted).toContainEqual({
      source: MOTION_SOURCE,
      type: 'ready',
      durationInFrames: 90,
      width: 1080,
      height: 1920,
      version: 1,
    })
  })

  it('seek recebe QUADRO e converte para segundos lá dentro', async () => {
    const { api, writes } = makePage({ meta: 'fps=30,duration=1' })
    await api.seek(15)
    expect(writes).toEqual([500]) // 15/30 s
  })

  it('espera os delayRender abertos antes de aplicar o quadro', async () => {
    const { api, writes } = makePage({ meta: 'fps=30,duration=1' })
    const handle = api.delayRender()
    const pending = api.seek(6)
    await tick()
    expect(writes).toEqual([]) // ainda esperando o handle
    api.continueRender(handle)
    await pending
    expect(writes).toEqual([200])
  })

  it('estoura em erro em vez de pendurar quando o handle não é liberado', async () => {
    vi.useFakeTimers()
    try {
      const { api } = makePage({ meta: 'fps=30,duration=1' })
      const handle = api.delayRender()
      const pending = api.seek(2)
      const outcome = expect(pending).rejects.toThrow(/delayRender/)
      await vi.advanceTimersByTimeAsync(10_000)
      await outcome
      api.continueRender(handle)
    } finally {
      vi.useRealTimers()
    }
  })

  it('nunca enfileira seeks sobrepostos: o mais novo vence e o velho é descartado', async () => {
    const { api, writes } = makePage({ meta: 'fps=30,duration=1' })
    const handle = api.delayRender()
    const first = api.seek(1)
    const second = api.seek(2)
    api.continueRender(handle)
    await first
    await second
    expect(writes).toHaveLength(1)
    expect(writes[0]).toBeCloseTo((2 / 30) * 1000, 2)
  })

  it('usa o seek da composição (canvas etc.) passando o QUADRO, sem perder a API', async () => {
    const seen: number[] = []
    const { api, writes } = makePage({
      meta: 'fps=30,duration=1',
      predeclared: { seek: (frame: number) => void seen.push(frame) },
    })
    await api.seek(4)
    expect(seen).toEqual([4])
    // As animações CSS/vídeos continuam sendo buscados, como no render antigo.
    expect(writes[0]).toBeCloseTo((4 / 30) * 1000, 2)
    expect(typeof api.delayRender).toBe('function')
  })

  it('aplica um comando do host vindo do parent', async () => {
    const { listeners, writes, parent } = makePage({ meta: 'fps=30,duration=1' })
    expect(listeners).toHaveLength(1)
    listeners[0]({ data: { source: MOTION_SOURCE, type: 'seek', frame: 4 }, source: parent })
    await tick()
    expect(writes[0]).toBeCloseTo((4 / 30) * 1000, 2)

    // De outra origem/comando desconhecido, ignora.
    listeners[0]({ data: { source: 'chat', type: 'seek', frame: 9 }, source: parent })
    listeners[0]({ data: { source: MOTION_SOURCE, type: 'ready' }, source: parent })
    await tick()
    expect(writes).toHaveLength(1)
  })

  it('aceita a declaração antiga window.orbitMotion = { … } sem apagar a API', async () => {
    const { win, api, posted } = makePage({})
    expect(api.durationInFrames).toBeUndefined()
    // A composição declara DEPOIS do runtime: faz merge (os números entram na
    // API, delayRender/seek continuam de pé) e o ready sai com o novo tamanho.
    win.orbitMotion = { duration: 2, fps: 30 }
    await tick(2)
    expect(api.durationInFrames).toBe(60)
    expect(typeof api.seek).toBe('function')
    expect(posted.some((m) => m.type === 'ready' && m.durationInFrames === 60)).toBe(true)
  })

  it('aceita o comprimento declarado em QUADROS (durationInFrames)', () => {
    // O contrato novo: a composição declara o comprimento em quadros, junto do
    // próprio seek (é o esqueleto que a skill de motion ensina).
    const { api, posted } = makePage({
      predeclared: { width: 1920, height: 1080, fps: 30, durationInFrames: 120, seek: () => {} },
    })
    expect(api.durationInFrames).toBe(120)
    expect(posted).toContainEqual({
      source: MOTION_SOURCE,
      type: 'ready',
      durationInFrames: 120,
      width: 1920,
      height: 1080,
      version: 1,
    })
  })

  it('aceita durationInFrames atribuído depois do runtime', async () => {
    const { win, api } = makePage({ meta: 'fps=30' })
    expect(api.durationInFrames).toBeUndefined()
    win.orbitMotion.durationInFrames = 90
    await tick(2)
    expect(api.durationInFrames).toBe(90)
  })

  it('captura o seek que a composição atribui depois do runtime', async () => {
    const { win, api, writes } = makePage({ meta: 'fps=30,duration=1' })
    const seen: number[] = []
    win.orbitMotion.seek = (frame: number) => void seen.push(frame)
    expect(api.seek).not.toBe(writes) // a API continua com o seek do runtime
    await api.seek(9)
    expect(seen).toEqual([9])
  })
})

describe('play do runtime (relógio e rAF controlados pelo teste)', () => {
  // 3 quadros a 30 fps: o fim chega rápido e o último quadro é o caso do bug.
  const make3 = () => makePage({ meta: 'fps=30,duration=0.1', manual: true })

  it('com loop ligado o play dá a volta em vez de parar no último quadro', async () => {
    const page = make3()
    send(page, 'loop', { on: true })
    send(page, 'play')
    await step(page, 1000 / 30)
    await step(page, 1000 / 30)
    // Chegou ao último quadro (2) e NÃO parou: o quadro seguinte já está agendado.
    expect(timeFrames(page)).toEqual([1, 2])
    await step(page, 1000 / 30)
    // Passou do fim e voltou ao início.
    expect(timeFrames(page)).toEqual([1, 2, 0])
    // E continua andando depois da volta.
    await step(page, 1000 / 30)
    expect(timeFrames(page)).toEqual([1, 2, 0, 1])
  })

  it('sem loop, para no último quadro e não anda mais', async () => {
    const page = make3()
    send(page, 'play')
    for (let i = 0; i < 5; i++) await step(page, 1000 / 30)
    // Prende no último quadro (não num quadro que não existe) e pausa.
    expect(timeFrames(page)).toEqual([1, 2, 2])
    await step(page, 1000 / 30)
    expect(timeFrames(page)).toEqual([1, 2, 2])
  })

  it('pause para o play', async () => {
    const page = make3()
    send(page, 'play')
    await step(page, 1000 / 30)
    send(page, 'pause')
    const before = timeFrames(page).length
    await step(page, 1000 / 30)
    expect(timeFrames(page)).toHaveLength(before)
  })
})

describe('injectMotionRuntime', () => {
  it('puts the runtime as the FIRST script of <head>', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><script src="gsap.min.js"></script></head><body></body></html>'
    const out = injectMotionRuntime(html, 'orbit-motion', 'mv_abc')
    expect(out).toContain(TAG)
    expect(out.indexOf(TAG)).toBeGreaterThan(out.indexOf('<head>'))
    expect(out.indexOf(TAG)).toBeLessThan(out.indexOf('<meta'))
    // A URL servida pelo scheme é o caminho reservado.
    expect(TAG).toContain(`orbit-motion://mv_abc${MOTION_RUNTIME_PATH}`)
  })

  it('handles a head with attributes and an uppercase tag', () => {
    const html = '<html><HEAD class="x"><title>t</title></HEAD><body></body></html>'
    const out = injectMotionRuntime(html, 'orbit-motion', 'mv_abc')
    expect(out.indexOf(TAG)).toBeGreaterThan(out.indexOf('<HEAD'))
    expect(out.indexOf(TAG)).toBeLessThan(out.indexOf('<title>'))
  })

  it('creates a head when there is none, and prefixes when not even <html> is there', () => {
    const withHtml = injectMotionRuntime('<html><body><h1>oi</h1></body></html>', 'orbit-motion', 'mv_abc')
    expect(withHtml).toContain(`<head>${TAG}</head>`)
    const fragment = injectMotionRuntime('<div>oi</div>', 'orbit-motion', 'mv_abc')
    expect(fragment.startsWith(TAG)).toBe(true)
  })

  it('never injects twice', () => {
    const once = injectMotionRuntime('<head></head>', 'orbit-motion', 'mv_abc')
    expect(injectMotionRuntime(once, 'orbit-motion', 'mv_abc')).toBe(once)
  })
})
