/**
 * O player de motion no celular.
 *
 * O que se verifica aqui é o contrato com a página, que é o que faz a peça
 * andar: a sonda que pergunta a duração, o `seek` em QUADROS (a unidade do
 * runtime), o relógio do play derivando o quadro do tempo, o laço e a
 * degradação quando a página não responde ou recusa o seek.
 *
 * O que NÃO se verifica: o arrasto da régua. No jsdom não há layout (a largura
 * da trilha é 0 via `onLayout`), então o gesto não tem geometria para virar
 * quadro — a conta que ele faz, `frameAtX`, é testada direto.
 */
import type { PieceRef } from '@orbit/shared'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MotionViewer,
  formatTime,
  frameAtX,
  resolveSpec,
} from './motion'

// O WebView real é nativo: aqui ele vira um host inerte que entrega o
// `onLoadEnd`, guarda as props (para simular as respostas da página) e registra
// o `injectJavaScript` que o player usa.
const harness = vi.hoisted(() => ({
  inject: vi.fn(),
  web: { current: null as Record<string, any> | null },
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const { View } = await import('react-native')
  const WebView = React.forwardRef<unknown, Record<string, any>>(function WebViewStub(props, ref) {
    harness.web.current = props
    React.useImperativeHandle(ref, () => ({ injectJavaScript: harness.inject }))
    return React.createElement(View, { testID: props.testID })
  })
  return { __esModule: true, WebView, default: WebView }
})

// Os rótulos são as chaves: o teste não depende do bundle de i18n.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

// Ícones: o desenho não é o que se verifica. `Repeat` não está no mock global
// (test-env) — a lista aqui é a do player mais a do `PieceView`.
vi.mock('lucide-react-native', () => {
  const names = ['AlertCircle', 'Maximize2', 'Pause', 'Play', 'Repeat', 'RotateCw', 'X']
  const icons: Record<string, unknown> = { __esModule: true }
  for (const name of names) icons[name] = () => null
  return icons
})

const SOURCE = 'orbit-motion-player'
const URL_PIECE = 'http://192.168.0.2:7777/api/file/motion/mv_ab12/tok'

const PIECE: PieceRef = {
  kind: 'motion',
  id: 'mv_ab12',
  url: URL_PIECE,
  title: 'Intro',
}

/** A peça de 3 s a 30 fps do exemplo: 90 quadros. */
const SPEC = {
  source: SOURCE,
  type: 'spec',
  fps: 30,
  durationInFrames: 90,
  width: 1920,
  height: 1080,
  seek: true,
}

/** Quadros de todos os `seek` injetados, na ordem. */
function seeks(): number[] {
  const frames: number[] = []
  for (const call of harness.inject.mock.calls as unknown[][]) {
    const match = /api\.seek\((\d+)\)/.exec(String(call[0] ?? ''))
    if (match) frames.push(Number(match[1]))
  }
  return frames
}

function lastSeek(): number | undefined {
  const frames = seeks()
  return frames[frames.length - 1]
}

function injectionsMatching(pattern: RegExp): string[] {
  return (harness.inject.mock.calls as unknown[][])
    .map((call) => String(call[0] ?? ''))
    .filter((js) => pattern.test(js))
}

/** A página terminou de carregar. */
function load() {
  act(() => {
    harness.web.current?.onLoadEnd?.()
  })
}

/** A página falou (postMessage → onMessage). */
function reply(payload: Record<string, unknown>) {
  act(() => {
    harness.web.current?.onMessage?.({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

function renderPlayer(piece: PieceRef = PIECE) {
  return render(<MotionViewer piece={piece} />)
}

function timeLabel(): string {
  return screen.getByTestId('motion-time').textContent ?? ''
}

beforeEach(() => {
  // O jsdom não tem janela: sem isto `useWindowDimensions` devolve 0x0 e o palco
  // não tem largura para enquadrar a peça (o teste de `zoom` cairia no vazio).
  // `visualViewport` é de onde o react-native-web lê o tamanho, e o evento de
  // resize é o que faz ele reler.
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { width: 390, height: 844, scale: 1 },
  })
  window.dispatchEvent(new Event('resize'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  harness.inject.mockClear()
  harness.web.current = null
})

describe('contrato da página (puro)', () => {
  it('a duração em quadros é canônica e vence a duração em segundos', () => {
    const spec = resolveSpec({ fps: 30, durationInFrames: 90, duration: 10, metaDuration: 4 })
    expect(spec).toEqual({ fps: 30, frames: 90, width: 1920, height: 1080, seekable: false })
  })

  it('sem quadros, os segundos viram quadros com o fps resolvido (api > meta > 30)', () => {
    expect(resolveSpec({ fps: 60, duration: 2 })?.frames).toBe(120)
    expect(resolveSpec({ metaFps: 24, metaDuration: 2 })?.frames).toBe(48)
    expect(resolveSpec({ duration: 2 })?.frames).toBe(60)
  })

  it('a timeline do GSAP e o piece.count entram por último, na ordem do runtime', () => {
    expect(resolveSpec({ timeline: 1.5 })?.frames).toBe(45)
    expect(resolveSpec({ metaDuration: 2 }, 10)?.frames).toBe(60)
    expect(resolveSpec({}, 4)?.frames).toBe(120)
  })

  it('sem comprimento nenhum devolve null — não inventa duração', () => {
    expect(resolveSpec({ fps: 30 })).toBeNull()
    expect(resolveSpec({ duration: 0, timeline: 0, metaDuration: 0 }, 0)).toBeNull()
  })

  it('o tamanho do documento cai para 1920x1080 como no runtime', () => {
    const spec = resolveSpec({ durationInFrames: 10, metaWidth: 1080, metaHeight: 1080 })
    expect(spec?.width).toBe(1080)
    expect(spec?.height).toBe(1080)
  })

  it('o tempo é m:ss, com segundos de dois dígitos', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(3.9)).toBe('0:04')
    expect(formatTime(2.966)).toBe('0:03')
    expect(formatTime(61)).toBe('1:01')
    expect(formatTime(Number.NaN)).toBe('0:00')
    expect(formatTime(-2)).toBe('0:00')
  })

  it('o x da trilha vira quadro inteiro, preso ao intervalo', () => {
    expect(frameAtX(0, 300, 90)).toBe(0)
    expect(frameAtX(150, 300, 90)).toBe(45)
    expect(frameAtX(300, 300, 90)).toBe(89)
    expect(frameAtX(-40, 300, 90)).toBe(0)
    expect(frameAtX(900, 300, 90)).toBe(89)
    expect(frameAtX(100, 0, 90)).toBe(0)
  })
})

describe('motion no celular', () => {
  it('a peça é carregada pela URL que o desktop assinou', () => {
    renderPlayer()
    expect(screen.getByTestId('piece-view')).toBeTruthy()
    expect(harness.web.current?.source).toEqual({ uri: URL_PIECE })
    // Nada é injetado antes de a página existir.
    expect(harness.inject).not.toHaveBeenCalled()
  })

  it('ao carregar, sonda o formato e posiciona no quadro 0', () => {
    renderPlayer()
    load()

    const [probe] = injectionsMatching(/durationInFrames/).slice(0, 1)
    expect(probe).toContain(SOURCE)
    expect(probe).toContain('meta[name="orbit-motion"]')
    expect(lastSeek()).toBe(0)
  })

  it('a duração vem da página e o tempo aparece como 0:00 / 0:03', () => {
    renderPlayer()
    load()
    reply(SPEC)

    expect(timeLabel()).toBe('0:00 / 0:03')
    // A régua fala em quadros, a mesma unidade do `seek`.
    const track = screen.getByTestId('motion-track')
    expect(track.getAttribute('aria-valuemax')).toBe('89')
    expect(track.getAttribute('aria-valuenow')).toBe('0')
    expect(track.getAttribute('aria-valuetext')).toBe('0:00 / 0:03')
  })

  it('a peça é enquadrada no palco (a composição é um documento de 1920x1080)', () => {
    renderPlayer()
    load()
    reply(SPEC)

    const [fit] = injectionsMatching(/style\.zoom/).reverse().slice(0, 1)
    expect(fit).toBeDefined()
    const scale = Number(/zoom = '([\d.]+)'/.exec(fit ?? '')?.[1])
    expect(scale).toBeGreaterThan(0)
    expect(scale).toBeLessThan(1)
  })

  it('tocar manda um seek por quadro e avança o tempo', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-play'))
    expect(screen.getByLabelText('pieces.motion.pause')).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(1100)
    })

    // 1100 ms a 30 fps: o relógio da tela já passou do quadro 30.
    expect(lastSeek()).toBeGreaterThanOrEqual(30)
    expect(timeLabel()).toBe('0:01 / 0:03')
  })

  it('parar no meio congela onde estava', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-play'))
    act(() => {
      vi.advanceTimersByTime(700)
    })
    fireEvent.click(screen.getByLabelText('pieces.motion.pause'))
    const frozen = lastSeek()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(lastSeek()).toBe(frozen)
    expect(screen.getByLabelText('pieces.motion.play')).toBeTruthy()
  })

  it('com laço ligado, o fim volta ao começo', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-play'))
    act(() => {
      // 4 s numa peça de 3 s: passou do fim e recomeçou.
      vi.advanceTimersByTime(4000)
    })

    expect(lastSeek()).toBeLessThan(90)
    expect(screen.getByLabelText('pieces.motion.pause')).toBeTruthy()
  })

  it('sem laço, para no último quadro', () => {
    vi.useFakeTimers()
    renderPlayer()
    load()
    reply(SPEC)

    fireEvent.click(screen.getByTestId('motion-loop'))
    fireEvent.click(screen.getByTestId('motion-play'))
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(lastSeek()).toBe(89)
    expect(timeLabel()).toBe('0:03 / 0:03')
    expect(screen.getByLabelText('pieces.motion.play')).toBeTruthy()
  })

  it('página que responde sem comprimento nenhum: controles desligados', () => {
    renderPlayer()
    load()
    reply({ source: SOURCE, type: 'spec', fps: 30, seek: true })

    expect(timeLabel()).toBe('0:00 / –:–')
    fireEvent.click(screen.getByTestId('motion-play'))
    expect(seeks().filter((frame) => frame > 0)).toEqual([])
  })

  it('peça sem seek na página: mostra a duração e não finge que toca', () => {
    renderPlayer()
    load()
    reply({ ...SPEC, seek: false })

    expect(timeLabel()).toBe('0:00 / 0:03')
    fireEvent.click(screen.getByTestId('motion-play'))
    expect(seeks().filter((frame) => frame > 0)).toEqual([])
  })

  it('seek que estoura na página desliga o controle', () => {
    renderPlayer()
    load()
    reply(SPEC)

    reply({ source: SOURCE, type: 'error', message: 'boom' })
    fireEvent.click(screen.getByTestId('motion-play'))
    expect(seeks().filter((frame) => frame > 0)).toEqual([])
  })

  it('mensagem de outra origem não mexe em nada', () => {
    renderPlayer()
    load()
    reply({ source: 'qualquer-outra', type: 'spec', durationInFrames: 90, seek: true })

    expect(timeLabel()).toBe('0:00 / –:–')
  })

  it('o piece.count é o último recurso quando a página não declara duração', () => {
    renderPlayer({ ...PIECE, count: 4 })
    load()
    reply({ source: SOURCE, type: 'spec', fps: 30, seek: true })

    expect(timeLabel()).toBe('0:00 / 0:04')
  })
})
