/**
 * The design viewer on the phone.
 *
 * What is guaranteed here is what decides whether the person sees the piece: the `canvas.json`
 * (which is NOT HTML) becoming a list of screens, each artboard addressed from the
 * signed URL of the piece, the navigation (arrows, counter, screen chips) and the
 * states that used to become a broken tile — empty canvas, network/token error and
 * one screen that fails while the others open.
 *
 * The drawing of the artboard (the real WebView) does not run in jsdom: the stub below
 * only stores the props, which is how one interrogates which file was requested.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PieceRef } from '@orbit/shared'

import { DesignViewer, artboardUrl, parseDesignCanvas, screenLabel } from './design'

const { webviews } = vi.hoisted(() => ({ webviews: [] as Record<string, unknown>[] }))

// WebView: each render records the props received (src, onHttpError…). The
// global alias of vitest only returns an inert View and is no use to fire an error.
vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const { View } = await import('react-native')
  return {
    WebView: (props: Record<string, unknown>) => {
      webviews.push(props)
      return React.createElement(View, { testID: String(props.testID ?? 'webview') })
    },
  }
})

// Icons: the global mock of test-env does not know `ChevronLeft`, used by the arrows.
vi.mock('lucide-react-native', async () => {
  const React = await import('react')
  const Icon = () => React.createElement('i')
  return {
    AlertCircle: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    Frame: Icon,
    RotateCw: Icon,
    Maximize2: Icon,
    X: Icon,
  }
})

// Labels: the keys instead of the bundle, so the test does not depend on the language.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

vi.mock('~/stores/theme-store', () => ({
  useThemeStore: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'dark' }),
}))

const CANVAS_URL = 'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/screen/canvas.json'

const PIECE: PieceRef = {
  kind: 'design',
  id: 'dsg_abc123',
  url: CANVAS_URL,
  title: 'Landing',
  count: 3,
}

const canvas = (order: string[], boards: Record<string, Record<string, unknown>>) => ({
  v: 1,
  boards,
  order,
})

const THREE = canvas(
  ['Home.html', 'Pricing.html', 'Signup.html'],
  {
    'Home.html': { title: 'Home', x: 0, y: 0, w: 390, h: 844 },
    'Pricing.html': { x: 430, y: 0, w: 390, h: 844 },
    'Signup.html': { title: 'Signup form', x: 860, y: 0, w: 390, h: 844 },
  },
)

function stubFetch(...responses: { ok?: boolean; status?: number; json?: () => Promise<unknown> }[]) {
  const mock = vi.fn()
  for (const response of responses) {
    mock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => THREE, ...response })
  }
  vi.stubGlobal('fetch', mock)
  return mock
}

const lastWebView = () => webviews[webviews.length - 1]

/** The file the host requested — `PieceView` delivers the URL in `source.uri`. */
const currentUri = () => (lastWebView().source as { uri?: string }).uri ?? ''

const counter = () => screen.getByTestId('design-counter').textContent?.replace(/\s+/g, ' ')

beforeEach(() => {
  webviews.length = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('parseDesignCanvas', () => {
  it('reads the screens in index order', () => {
    expect(parseDesignCanvas(THREE)).toEqual([
      { file: 'Home.html', title: 'Home' },
      { file: 'Pricing.html', title: undefined },
      { file: 'Signup.html', title: 'Signup form' },
    ])
  })

  it('ignores what is in the order without an artboard, and does not repeat', () => {
    const screens = parseDesignCanvas(
      canvas(['Home.html', 'Home.html', 'Ghost.html'], { 'Home.html': { x: 0, y: 0 } }),
    )
    expect(screens).toEqual([{ file: 'Home.html', title: undefined }])
  })

  it('an artboard outside the order is still a screen, in the canvas reading order', () => {
    const screens = parseDesignCanvas(
      canvas(['Z.html'], {
        'Z.html': { x: 900, y: 0 },
        'B.html': { x: 0, y: 0 },
        'A.html': { x: 0, y: 0 },
      }),
    )
    expect(screens.map((s) => s.file)).toEqual(['Z.html', 'A.html', 'B.html'])
  })

  it('an empty canvas, without order or without boards, is not a screen list', () => {
    expect(parseDesignCanvas(canvas([], {}))).toEqual([])
    expect(parseDesignCanvas({ v: 1 })).toEqual([])
    expect(parseDesignCanvas({ boards: {} })).toEqual([])
    expect(parseDesignCanvas(null)).toEqual([])
    expect(parseDesignCanvas('canvas.json')).toEqual([])
  })

  it('a file name that escapes the folder does not become a screen', () => {
    expect(parseDesignCanvas(canvas(['../Other.html', 'Ok.html'], { '../Other.html': {}, 'Ok.html': {} }))).toEqual([
      { file: 'Ok.html', title: undefined },
    ])
  })
})

describe('artboardUrl', () => {
  it('swaps the canvas.json for the screen file, keeping the token', () => {
    expect(artboardUrl(CANVAS_URL, 'Pricing.html')).toBe(
      'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/screen/Pricing.html',
    )
  })

  it('encodes the name and preserves the subfolder', () => {
    expect(artboardUrl(CANVAS_URL, 'sub/Café.html')).toBe(
      'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/screen/sub/Caf%C3%A9.html',
    )
  })

  it('ignores the query and hash of the piece URL', () => {
    expect(artboardUrl(`${CANVAS_URL}?r=1700000000`, 'Home.html')).toBe(
      'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/screen/Home.html',
    )
  })

  it('without canvas.json at the end, the file goes into the folder instead of eating the token', () => {
    expect(artboardUrl('http://host/api/file/design/dsg_abc/tok', 'Home.html')).toBe(
      'http://host/api/file/design/dsg_abc/tok/Home.html',
    )
  })

  it('a URL without a folder addresses nothing', () => {
    expect(artboardUrl('canvas.json', 'Home.html')).toBeNull()
    expect(artboardUrl(CANVAS_URL, '')).toBeNull()
  })
})

describe('screenLabel', () => {
  it('uses the index title and, without it, the file name', () => {
    expect(screenLabel({ file: 'Home.html', title: 'Start' })).toBe('Start')
    expect(screenLabel({ file: 'sub/Pricing.html' })).toBe('Pricing')
    expect(screenLabel({ file: 'Signup.htm' })).toBe('Signup')
    expect(screenLabel({ file: 'Signup.html', title: '   ' })).toBe('Signup')
  })
})

describe('DesignViewer', () => {
  it('fetches the canvas and opens the first screen', async () => {
    const fetchMock = stubFetch({})

    render(<DesignViewer piece={PIECE} />)

    expect(screen.getByTestId('design-loading')).toBeTruthy()

    await waitFor(() => expect(counter()).toBe('1 / 3'))
    expect(fetchMock).toHaveBeenCalledWith(CANVAS_URL, expect.anything())
    expect(currentUri()).toBe(`${CANVAS_URL.slice(0, -'canvas.json'.length)}Home.html`)
    // The open screen is the one the host bar announces.
    expect(lastWebView().accessibilityLabel).toBe('Home')
  })

  it('the arrows walk one screen at a time and stop at the ends', async () => {
    stubFetch({})
    render(<DesignViewer piece={PIECE} />)
    await waitFor(() => expect(counter()).toBe('1 / 3'))

    // At the beginning there is nowhere to go back to: the arrow changes nothing.
    fireEvent.click(screen.getByTestId('design-prev'))
    expect(counter()).toBe('1 / 3')

    fireEvent.click(screen.getByTestId('design-next'))
    expect(counter()).toBe('2 / 3')
    expect(currentUri()).toContain('/Pricing.html')

    fireEvent.click(screen.getByTestId('design-next'))
    expect(counter()).toBe('3 / 3')
    expect(currentUri()).toContain('/Signup.html')

    // On the last one, the next does not go past the end.
    fireEvent.click(screen.getByTestId('design-next'))
    expect(counter()).toBe('3 / 3')
    expect(currentUri()).toContain('/Signup.html')

    fireEvent.click(screen.getByTestId('design-prev'))
    expect(counter()).toBe('2 / 3')
    expect(currentUri()).toContain('/Pricing.html')
  })

  it('the screen strip jumps straight to the chosen screen', async () => {
    stubFetch({})
    render(<DesignViewer piece={PIECE} />)
    await waitFor(() => expect(counter()).toBe('1 / 3'))

    fireEvent.click(screen.getByTestId('design-screen-2'))
    expect(counter()).toBe('3 / 3')
    expect(currentUri()).toContain('/Signup.html')

    fireEvent.click(screen.getByTestId('design-screen-0'))
    expect(counter()).toBe('1 / 3')
    expect(currentUri()).toContain('/Home.html')
  })

  it('one screen at a time: the previous WebView is unmounted', async () => {
    stubFetch({})
    render(<DesignViewer piece={PIECE} />)
    await waitFor(() => expect(counter()).toBe('1 / 3'))

    fireEvent.click(screen.getByTestId('design-next'))
    const mounted = screen.getAllByTestId('piece-view')
    expect(mounted).toHaveLength(1)
    expect(currentUri()).toContain('/Pricing.html')
  })

  it('a canvas fetch error: error box and a "try again" that refetches', async () => {
    // Expired token/desktop off: the first fetch fails, the second one (the retry)
    // finds the index.
    const fetchMock = stubFetch({ ok: false, status: 401 }, {})
    render(<DesignViewer piece={PIECE} />)

    expect(await screen.findByTestId('design-error')).toBeTruthy()
    expect(screen.getByText('HTTP 401')).toBeTruthy()
    // No WebView pointing at the JSON.
    expect(webviews).toHaveLength(0)

    fireEvent.click(screen.getByTestId('design-retry'))
    await waitFor(() => expect(counter()).toBe('1 / 3'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('malformed JSON falls back to the error, not to an empty or broken screen', async () => {
    stubFetch({
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    })
    render(<DesignViewer piece={PIECE} />)

    expect(await screen.findByTestId('design-error')).toBeTruthy()
    expect(screen.queryByTestId('design-empty')).toBeNull()
    expect(screen.queryByTestId('piece-view')).toBeNull()
  })

  it('a canvas without screens shows the empty state, with no WebView', async () => {
    stubFetch({ json: async () => canvas([], {}) })
    render(<DesignViewer piece={PIECE} />)

    expect(await screen.findByTestId('design-empty')).toBeTruthy()
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(screen.queryByTestId('design-counter')).toBeNull()
    expect(screen.queryByTestId('design-screens')).toBeNull()
  })

  it('a screen that fails takes neither the others nor the navigation down', async () => {
    stubFetch({})
    render(<DesignViewer piece={PIECE} />)
    await waitFor(() => expect(counter()).toBe('1 / 3'))

    // The HTTP response of the first artboard failed: the host shows the error, and the
    // error belongs to that screen.
    act(() => {
      ;(lastWebView().onHttpError as (event: unknown) => void)({ nativeEvent: { statusCode: 404 } })
    })
    expect(screen.getByText('parts.preview.error')).toBeTruthy()
    expect(counter()).toBe('1 / 3')

    fireEvent.click(screen.getByTestId('design-next'))
    await waitFor(() => expect(counter()).toBe('2 / 3'))
    expect(currentUri()).toContain('/Pricing.html')
    expect(screen.queryByText('parts.preview.error')).toBeNull()

    // And the one that failed stays in the strip, to come back later (the host has the retry).
    fireEvent.click(screen.getByTestId('design-screen-0'))
    expect(counter()).toBe('1 / 3')
    expect(currentUri()).toContain('/Home.html')
  })

  it('unmounting in the middle of the fetch does not blow up', async () => {
    stubFetch({})
    const view = render(<DesignViewer piece={PIECE} />)
    view.unmount()
    await Promise.resolve()
    expect(webviews).toHaveLength(0)
  })
})
