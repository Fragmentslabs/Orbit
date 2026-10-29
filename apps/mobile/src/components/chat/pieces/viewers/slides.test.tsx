/**
 * O deck de slides no celular.
 *
 * O que se prova aqui é o que decide se a pessoa vê o deck ou um buraco:
 *
 * - o deck é carregado pela URL assinada (`src`), e o PALCO é injetado por
 *   `onReady` — o script é EXECUTADO num documento de verdade, com as seções do
 *   deck no lugar, e é ele que pagina (setas do app por `orbitSlides.go`, swipe
 *   dentro do documento, índice publicado em `onMessage`);
 * - as setas laterais e o contador acompanham o slide que está na tela;
 * - os três estados de falha (carregando, erro de rede/token, deck vazio).
 *
 * O `WebView` não existe no jsdom: aqui ele é um host que guarda as props e
 * entrega o `injectJavaScript` do ref (é o que o `onReady` do `PieceView`
 * repassa), para o teste poder falar com o deck pela mesma via do aparelho.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Rótulos de verdade: o contador é interpolado (`{{index}} / {{count}}`).
import '~/i18n'

import { deckStageSource, readSlidesMessage, SlidesViewer } from './slides'

// O `ChevronLeft` não está na lista de ícones do setup global (que é explícita
// de propósito): este arquivo declara os próprios, incluindo os do `PieceView`.
vi.mock('lucide-react-native', () => {
  const names = ['AlertCircle', 'ChevronLeft', 'ChevronRight', 'Maximize2', 'Presentation', 'RotateCw', 'X']
  const icons: Record<string, unknown> = { __esModule: true }
  for (const name of names) icons[name] = () => null
  return icons
})

const host = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  /** Tudo o que o app mandou para dentro da página pela ponte do `onReady`. */
  injected: [] as string[],
  /** Quantos WebViews estão montados (0 = o viewer tirou o deck de cena). */
  mounted: 0,
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef(
    (props: Record<string, unknown>, ref: React.ForwardedRef<{ injectJavaScript: (js: string) => void }>) => {
      host.props = props
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: (js: string) => host.injected.push(js),
      }))
      // A página carregou: é o que dispara o `onReady` do `PieceView`. Uma vez
      // por montagem — como o `onLoadEnd` do nativo, não a cada render.
      const loaded = React.useRef(props.onLoadEnd as (() => void) | undefined)
      React.useEffect(() => {
        host.mounted += 1
        loaded.current?.()
        return () => {
          host.mounted -= 1
        }
      }, [])
      return null
    },
  )
  WebView.displayName = 'MockWebView'
  return { __esModule: true, WebView }
})

const DECK = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="orbit-slides" content="width=1280,height=720">
<title>Orbit em 3 slides</title>
<style>.slide{height:100%}</style>
</head>
<body>
<section class="slide"><h1>Um</h1></section>

<section class="slide cover"><h1>Dois</h1></section>

<section class="slide"><h1>Três</h1></section>
</body>
</html>
`

const PIECE = {
  kind: 'slides' as const,
  id: 'sld_abc',
  url: 'http://192.168.0.10:4321/api/file/slides/sld_abc/tok-abc/index.html',
  title: 'Orbit em 3 slides',
}

const BACKGROUND = 'hsl(240, 11%, 4%)'

/** Entrega uma mensagem como o documento entrega (`PieceView` repassa o data). */
function say(data: unknown) {
  const onMessage = host.props.onMessage as
    | ((event: { nativeEvent: { data: string } }) => void)
    | undefined
  if (!onMessage) throw new Error('o deck não montou: sem onMessage')
  act(() => onMessage({ nativeEvent: { data: JSON.stringify(data) } }))
}

/** O último JS que o app mandou para a página. */
function lastInjection(): string {
  const js = host.injected.at(-1)
  if (!js) throw new Error('nada foi injetado no deck')
  return js
}

beforeEach(() => {
  host.props = {}
  host.injected = []
  host.mounted = 0
})

afterEach(cleanup)

describe('mensagens do deck', () => {
  it('só aceita mensagem do deck, e nunca um índice inválido', () => {
    expect(readSlidesMessage('{"source":"orbit-slides","type":"change","index":2,"total":5}')).toEqual({
      type: 'change',
      index: 2,
      total: 5,
    })
    expect(readSlidesMessage('{"source":"orbit-slides","type":"ready","total":5}')).toEqual({
      type: 'ready',
      total: 5,
    })
    expect(readSlidesMessage('lixo')).toBeNull()
    expect(readSlidesMessage('{"source":"outra-coisa","type":"change","index":1}')).toBeNull()
    expect(readSlidesMessage('{"source":"orbit-slides","type":"desconhecido"}')).toBeNull()
    // Total zero ou negativo não é total: o contador não pode dizer "1 / 0".
    expect(readSlidesMessage('{"source":"orbit-slides","type":"change","index":-3,"total":0}')).toEqual({
      type: 'change',
      index: 0,
    })
  })
})

describe('palco injetado', () => {
  it('leva o CSS, a cor do app e o script, num texto único', () => {
    const source = deckStageSource(BACKGROUND)

    expect(source).toContain('__orbitSlidesMobile')
    expect(source).toContain('orbit-slides-stage')
    expect(source).toContain(`--orbit-bg:${BACKGROUND}`)
    expect(source).toContain('window.orbitSlides')
    // Não há tag de script para o JSON fechar por acidente.
    expect(source).not.toContain('</script')
  })

  /** Executa o documento do deck com o palco injetado, como no WebView. */
  function runDeck(html: string) {
    const deck = window.document.implementation.createHTMLDocument('deck')
    deck.documentElement.innerHTML = html

    const messages: Record<string, unknown>[] = []
    const fakeWindow = {
      innerWidth: 400,
      innerHeight: 800,
      ReactNativeWebView: { postMessage: (data: string) => messages.push(JSON.parse(data)) },
      addEventListener: () => {},
      orbitSlides: undefined as
        | { go: (index: number) => void; next: () => void; total: number; index: number }
        | undefined,
    }
    new Function('window', 'document', deckStageSource(BACKGROUND))(fakeWindow, deck)

    return { deck, messages, scope: fakeWindow }
  }

  function touch(deck: Document, type: string, x: number, y: number) {
    const event = deck.createEvent('Event')
    event.initEvent(type, true, true)
    Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: y }] })
    return event
  }

  it('sobrepõe as seções e começa no primeiro slide', () => {
    const { deck, messages } = runDeck(DECK)

    expect(deck.querySelectorAll('.orbit-slides-stage > .orbit-slide').length).toBe(3)
    expect(deck.querySelectorAll('.orbit-slide.is-current').length).toBe(1)
    expect(deck.querySelector('.orbit-slide.is-current')?.textContent).toContain('Um')
    expect(deck.querySelector('.orbit-slide')?.getAttribute('data-index')).toBe('1')
    // O documento volta a aparecer: esconder era só a troca para o palco.
    expect(deck.documentElement.style.visibility).toBe('')
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'ready', index: 0, total: 3 })
  })

  it('a seta do app pagina pelo window.orbitSlides e publica o índice', () => {
    const { deck, messages, scope } = runDeck(DECK)

    scope.orbitSlides?.go(1)
    expect(deck.querySelector('.orbit-slide.is-current')?.textContent).toContain('Dois')
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 1, total: 3 })

    // Os limites são do palco: pedir -5 ou 99 não sai da faixa.
    scope.orbitSlides?.go(99)
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 2, total: 3 })
    scope.orbitSlides?.go(0)
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 0, total: 3 })
    scope.orbitSlides?.go(0)
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 0, total: 3 })
  })

  it('o swipe horizontal troca de slide, o vertical não', () => {
    const { deck, messages } = runDeck(DECK)
    const root = deck.getElementById('orbit-slides-root') as HTMLElement

    root.dispatchEvent(touch(deck, 'touchstart', 300, 400))
    root.dispatchEvent(touch(deck, 'touchend', 300, 100))
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'ready', index: 0, total: 3 })

    root.dispatchEvent(touch(deck, 'touchstart', 300, 400))
    root.dispatchEvent(touch(deck, 'touchend', 120, 410))
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 1, total: 3 })

    root.dispatchEvent(touch(deck, 'touchstart', 120, 400))
    root.dispatchEvent(touch(deck, 'touchend', 320, 405))
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 0, total: 3 })
  })

  it('deck sem slide nenhum avisa em vez de montar palco vazio', () => {
    const { deck, messages } = runDeck('<html><body><p>nada</p></body></html>')
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'empty' })
    expect(deck.getElementById('orbit-slides-root')).toBeNull()
  })

  it('um segundo inject na mesma página não monta um segundo palco', () => {
    const deck = window.document.implementation.createHTMLDocument('deck')
    deck.documentElement.innerHTML = DECK
    const fakeWindow = {
      innerWidth: 400,
      innerHeight: 800,
      ReactNativeWebView: { postMessage: () => {} },
      addEventListener: () => {},
    }
    const source = deckStageSource(BACKGROUND)
    new Function('window', 'document', source)(fakeWindow, deck)
    new Function('window', 'document', source)(fakeWindow, deck)

    expect(deck.querySelectorAll('#orbit-slides-root').length).toBe(1)
  })
})

describe('SlidesViewer', () => {
  it('carrega o deck pela URL assinada e injeta o palco quando a página abre', async () => {
    render(<SlidesViewer piece={PIECE} />)

    // `src` é o documento do deck: assets relativos e token seguem intactos.
    const source = host.props.source as { uri?: string }
    expect(source.uri).toBe(PIECE.url)
    // Já estamos em tela cheia: nada de botão de ampliar.
    expect(screen.queryByLabelText('Ampliar')).toBeNull()

    await waitFor(() => expect(host.injected.length).toBe(1))
    expect(lastInjection()).toContain('__orbitSlidesMobile')
    // Antes de o deck dizer que carregou não há seta nem contador para mentir.
    expect(screen.queryByTestId('slides-counter')).toBeNull()
    expect(screen.queryByTestId('slides-next')).toBeNull()
  })

  it('setas laterais e contador seguem o slide que o deck publica', async () => {
    render(<SlidesViewer piece={PIECE} />)
    await waitFor(() => expect(host.injected.length).toBe(1))

    say({ source: 'orbit-slides', type: 'ready', index: 0, total: 3 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('1 / 3')
    expect(screen.getByTestId('slides-previous')).toBeTruthy()
    expect(screen.getByTestId('slides-previous').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('slides-next').getAttribute('aria-disabled')).not.toBe('true')

    // A seta do app fala com o palco pelo inject — é assim que o slide vira.
    fireEvent.click(screen.getByTestId('slides-next'))
    expect(lastInjection()).toContain('window.orbitSlides && window.orbitSlides.go(1)')

    // E o palco devolve o índice; o contador acompanha.
    say({ source: 'orbit-slides', type: 'change', index: 2, total: 3 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('3 / 3')
    expect(screen.getByTestId('slides-next').getAttribute('aria-disabled')).toBe('true')

    // Mensagem de outra peça não mexe em nada.
    say({ source: 'orbit-motion', type: 'change', index: 0, total: 9 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('3 / 3')
  })

  it('deck de um slide só não ganha setas', async () => {
    render(<SlidesViewer piece={PIECE} />)
    await waitFor(() => expect(host.injected.length).toBe(1))

    say({ source: 'orbit-slides', type: 'ready', index: 0, total: 1 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('1 / 1')
    expect(screen.queryByTestId('slides-next')).toBeNull()
    expect(screen.queryByTestId('slides-previous')).toBeNull()
  })

  it('token vencido (HTTP 401) vira o erro do host, sem setas', async () => {
    render(<SlidesViewer piece={PIECE} />)
    await waitFor(() => expect(host.injected.length).toBe(1))

    const onHttpError = host.props.onHttpError as (event: {
      nativeEvent: { statusCode: number }
    }) => void
    act(() => onHttpError({ nativeEvent: { statusCode: 401 } }))

    expect(await screen.findByText('HTTP 401')).toBeTruthy()
    expect(screen.queryByTestId('slides-counter')).toBeNull()
    expect(screen.queryByTestId('slides-next')).toBeNull()
  })

  it('deck sem slides mostra o vazio, sem deixar o WebView na tela', async () => {
    render(<SlidesViewer piece={PIECE} />)
    await waitFor(() => expect(host.injected.length).toBe(1))

    say({ source: 'orbit-slides', type: 'empty' })

    expect(screen.getByTestId('slides-empty')).toBeTruthy()
    expect(screen.queryByTestId('slides-counter')).toBeNull()
    // O WebView sai de cena: um deck que não é deck não fica ocupando a tela.
    expect(host.mounted).toBe(0)
  })

  it('sem endereço (part antiga) é a prévia indisponível do host', () => {
    render(<SlidesViewer piece={{ ...PIECE, url: '' }} />)

    expect(screen.getByText('Prévia indisponível')).toBeTruthy()
    expect(host.mounted).toBe(0)
  })
})
