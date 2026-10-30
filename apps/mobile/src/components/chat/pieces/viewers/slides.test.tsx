/**
 * The slide deck on the phone.
 *
 * What is proven here is what decides whether the person sees the deck or a hole:
 *
 * - the deck is loaded through the signed URL (`src`), and the STAGE is injected by
 *   `onReady` — the script is EXECUTED in a real document, with the sections of the
 *   deck in place, and it is what paginates (arrows of the app through `orbitSlides.go`, swipe
 *   inside the document, index published in `onMessage`);
 * - the side arrows and the counter follow the slide that is on screen;
 * - the three failure states (loading, network/token error, empty deck).
 *
 * The `WebView` does not exist in jsdom: here it is a host that stores the props and
 * delivers the `injectJavaScript` of the ref (which is what the `onReady` of `PieceView`
 * forwards), so the test can talk to the deck through the same path as the device.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real labels: the counter is interpolated (`{{index}} / {{count}}`).
import '~/i18n'

import { deckStageSource, readSlidesMessage, SlidesViewer } from './slides'

// `ChevronLeft` is not in the icon list of the global setup (which is explicit
// on purpose): this file declares its own, including the ones of `PieceView`.
vi.mock('lucide-react-native', () => {
  const names = ['AlertCircle', 'ChevronLeft', 'ChevronRight', 'Maximize2', 'Presentation', 'RotateCw', 'X']
  const icons: Record<string, unknown> = { __esModule: true }
  for (const name of names) icons[name] = () => null
  return icons
})

const host = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  /** Everything the app sent into the page through the `onReady` bridge. */
  injected: [] as string[],
  /** How many WebViews are mounted (0 = the viewer took the deck out of the scene). */
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
      // The page loaded: it is what fires the `onReady` of `PieceView`. Once per
      // mount — like the native `onLoadEnd`, not on every render.
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
<title>Orbit in 3 slides</title>
<style>.slide{height:100%}</style>
</head>
<body>
<section class="slide"><h1>One</h1></section>

<section class="slide cover"><h1>Two</h1></section>

<section class="slide"><h1>Three</h1></section>
</body>
</html>
`

const PIECE = {
  kind: 'slides' as const,
  id: 'sld_abc',
  url: 'http://192.168.0.10:4321/api/file/slides/sld_abc/tok-abc/index.html',
  title: 'Orbit in 3 slides',
}

const BACKGROUND = 'hsl(240, 11%, 4%)'

/** Delivers a message the way the document does (`PieceView` forwards the data). */
function say(data: unknown) {
  const onMessage = host.props.onMessage as
    | ((event: { nativeEvent: { data: string } }) => void)
    | undefined
  if (!onMessage) throw new Error('the deck did not mount: no onMessage')
  act(() => onMessage({ nativeEvent: { data: JSON.stringify(data) } }))
}

/** The last JS the app sent to the page. */
function lastInjection(): string {
  const js = host.injected.at(-1)
  if (!js) throw new Error('nothing was injected into the deck')
  return js
}

beforeEach(() => {
  host.props = {}
  host.injected = []
  host.mounted = 0
})

afterEach(cleanup)

describe('deck messages', () => {
  it('only accepts a message from the deck, and never an invalid index', () => {
    expect(readSlidesMessage('{"source":"orbit-slides","type":"change","index":2,"total":5}')).toEqual({
      type: 'change',
      index: 2,
      total: 5,
    })
    expect(readSlidesMessage('{"source":"orbit-slides","type":"ready","total":5}')).toEqual({
      type: 'ready',
      total: 5,
    })
    expect(readSlidesMessage('junk')).toBeNull()
    expect(readSlidesMessage('{"source":"something-else","type":"change","index":1}')).toBeNull()
    expect(readSlidesMessage('{"source":"orbit-slides","type":"unknown"}')).toBeNull()
    // Zero or negative total is not a total: the counter cannot say "1 / 0".
    expect(readSlidesMessage('{"source":"orbit-slides","type":"change","index":-3,"total":0}')).toEqual({
      type: 'change',
      index: 0,
    })
  })
})

describe('injected stage', () => {
  it('carries the CSS, the app color and the script in a single text', () => {
    const source = deckStageSource(BACKGROUND)

    expect(source).toContain('__orbitSlidesMobile')
    expect(source).toContain('orbit-slides-stage')
    expect(source).toContain(`--orbit-bg:${BACKGROUND}`)
    expect(source).toContain('window.orbitSlides')
    // There is no script tag for the JSON to close by accident.
    expect(source).not.toContain('</script')
  })

  /** Runs the deck document with the injected stage, as in the WebView. */
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

  it('overlays the sections and starts on the first slide', () => {
    const { deck, messages } = runDeck(DECK)

    expect(deck.querySelectorAll('.orbit-slides-stage > .orbit-slide').length).toBe(3)
    expect(deck.querySelectorAll('.orbit-slide.is-current').length).toBe(1)
    expect(deck.querySelector('.orbit-slide.is-current')?.textContent).toContain('One')
    expect(deck.querySelector('.orbit-slide')?.getAttribute('data-index')).toBe('1')
    // The document shows up again: hiding it was only the swap to the stage.
    expect(deck.documentElement.style.visibility).toBe('')
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'ready', index: 0, total: 3 })
  })

  it('the app arrow pages through window.orbitSlides and publishes the index', () => {
    const { deck, messages, scope } = runDeck(DECK)

    scope.orbitSlides?.go(1)
    expect(deck.querySelector('.orbit-slide.is-current')?.textContent).toContain('Two')
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 1, total: 3 })

    // The limits belong to the stage: asking for -5 or 99 does not leave the range.
    scope.orbitSlides?.go(99)
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 2, total: 3 })
    scope.orbitSlides?.go(0)
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 0, total: 3 })
    scope.orbitSlides?.go(0)
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'change', index: 0, total: 3 })
  })

  it('a horizontal swipe changes the slide, a vertical one does not', () => {
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

  it('a deck with no slide at all reports it instead of mounting an empty stage', () => {
    const { deck, messages } = runDeck('<html><body><p>nothing</p></body></html>')
    expect(messages.at(-1)).toEqual({ source: 'orbit-slides', type: 'empty' })
    expect(deck.getElementById('orbit-slides-root')).toBeNull()
  })

  it('a second inject on the same page does not mount a second stage', () => {
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
  it('loads the deck from the signed URL and injects the stage when the page opens', async () => {
    render(<SlidesViewer piece={PIECE} />)

    // `src` is the deck document: relative assets and token stay intact.
    const source = host.props.source as { uri?: string }
    expect(source.uri).toBe(PIECE.url)
    // We are already in full screen: no zoom button.
    expect(screen.queryByLabelText('Enlarge')).toBeNull()

    await waitFor(() => expect(host.injected.length).toBe(1))
    expect(lastInjection()).toContain('__orbitSlidesMobile')
    // Before the deck says it loaded there is no arrow or counter to lie.
    expect(screen.queryByTestId('slides-counter')).toBeNull()
    expect(screen.queryByTestId('slides-next')).toBeNull()
  })

  it('side arrows and counter follow the slide the deck publishes', async () => {
    render(<SlidesViewer piece={PIECE} />)
    await waitFor(() => expect(host.injected.length).toBe(1))

    say({ source: 'orbit-slides', type: 'ready', index: 0, total: 3 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('1 / 3')
    expect(screen.getByTestId('slides-previous')).toBeTruthy()
    expect(screen.getByTestId('slides-previous').getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByTestId('slides-next').getAttribute('aria-disabled')).not.toBe('true')

    // The arrow of the app talks to the stage through the inject — that is how the slide flips.
    fireEvent.click(screen.getByTestId('slides-next'))
    expect(lastInjection()).toContain('window.orbitSlides && window.orbitSlides.go(1)')

    // And the stage reports the index back; the counter follows.
    say({ source: 'orbit-slides', type: 'change', index: 2, total: 3 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('3 / 3')
    expect(screen.getByTestId('slides-next').getAttribute('aria-disabled')).toBe('true')

    // A message from another piece changes nothing.
    say({ source: 'orbit-motion', type: 'change', index: 0, total: 9 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('3 / 3')
  })

  it('a single-slide deck gets no arrows', async () => {
    render(<SlidesViewer piece={PIECE} />)
    await waitFor(() => expect(host.injected.length).toBe(1))

    say({ source: 'orbit-slides', type: 'ready', index: 0, total: 1 })
    expect(screen.getByTestId('slides-counter').textContent).toBe('1 / 1')
    expect(screen.queryByTestId('slides-next')).toBeNull()
    expect(screen.queryByTestId('slides-previous')).toBeNull()
  })

  it('an expired token (HTTP 401) becomes the host error, with no arrows', async () => {
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

  it('a deck with no slides shows the empty state, without leaving the WebView on screen', async () => {
    render(<SlidesViewer piece={PIECE} />)
    await waitFor(() => expect(host.injected.length).toBe(1))

    say({ source: 'orbit-slides', type: 'empty' })

    expect(screen.getByTestId('slides-empty')).toBeTruthy()
    expect(screen.queryByTestId('slides-counter')).toBeNull()
    // The WebView leaves the scene: a deck that is not a deck does not keep the screen.
    expect(host.mounted).toBe(0)
  })

  it('without an address (an old part) it is the host preview unavailable', () => {
    render(<SlidesViewer piece={{ ...PIECE, url: '' }} />)

    expect(screen.getByText('Prévia indisponível')).toBeTruthy()
    expect(host.mounted).toBe(0)
  })
})
