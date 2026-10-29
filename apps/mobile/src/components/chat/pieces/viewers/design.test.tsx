/**
 * O viewer de design no celular.
 *
 * O que se garante aqui é o que decide se a pessoa vê a peça: o `canvas.json`
 * (que NÃO é HTML) virando lista de telas, cada artboard endereçada a partir da
 * URL assinada da peça, a navegação (setas, contador, chips de tela) e os
 * estados que antes viravam tile quebrado — canvas vazio, erro de rede/token e
 * uma tela que falha enquanto as outras abrem.
 *
 * O desenho da artboard (o WebView de verdade) não roda no jsdom: o stub abaixo
 * só guarda as props, que é como se interroga qual arquivo foi pedido.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PieceRef } from '@orbit/shared'

import { DesignViewer, artboardUrl, parseDesignCanvas, screenLabel } from './design'

const { webviews } = vi.hoisted(() => ({ webviews: [] as Record<string, unknown>[] }))

// WebView: cada render registra as props recebidas (src, onHttpError…). O alias
// global do vitest só devolve uma View inerte e não serve para disparar erro.
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

// Ícones: o mock global do test-env não conhece `ChevronLeft`, usado pelas setas.
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

// Rótulos: as chaves em vez do bundle, para o teste não depender do idioma.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

vi.mock('~/stores/theme-store', () => ({
  useThemeStore: (selector: (state: { resolved: string }) => unknown) => selector({ resolved: 'dark' }),
}))

const CANVAS_URL = 'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/tela/canvas.json'

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
    'Signup.html': { title: 'Cadastro', x: 860, y: 0, w: 390, h: 844 },
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

/** O arquivo que o host pediu — o `PieceView` entrega a URL em `source.uri`. */
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
  it('lê as telas na ordem do índice', () => {
    expect(parseDesignCanvas(THREE)).toEqual([
      { file: 'Home.html', title: 'Home' },
      { file: 'Pricing.html', title: undefined },
      { file: 'Signup.html', title: 'Cadastro' },
    ])
  })

  it('ignora o que está no order sem artboard, e não repete', () => {
    const screens = parseDesignCanvas(
      canvas(['Home.html', 'Home.html', 'Fantasma.html'], { 'Home.html': { x: 0, y: 0 } }),
    )
    expect(screens).toEqual([{ file: 'Home.html', title: undefined }])
  })

  it('artboard fora do order continua sendo tela, na ordem de leitura do canvas', () => {
    const screens = parseDesignCanvas(
      canvas(['Z.html'], {
        'Z.html': { x: 900, y: 0 },
        'B.html': { x: 0, y: 0 },
        'A.html': { x: 0, y: 0 },
      }),
    )
    expect(screens.map((s) => s.file)).toEqual(['Z.html', 'A.html', 'B.html'])
  })

  it('canvas vazio, sem order ou sem boards não é uma lista de telas', () => {
    expect(parseDesignCanvas(canvas([], {}))).toEqual([])
    expect(parseDesignCanvas({ v: 1 })).toEqual([])
    expect(parseDesignCanvas({ boards: {} })).toEqual([])
    expect(parseDesignCanvas(null)).toEqual([])
    expect(parseDesignCanvas('canvas.json')).toEqual([])
  })

  it('nome de arquivo que escapa da pasta não vira tela', () => {
    expect(parseDesignCanvas(canvas(['../Outro.html', 'Ok.html'], { '../Outro.html': {}, 'Ok.html': {} }))).toEqual([
      { file: 'Ok.html', title: undefined },
    ])
  })
})

describe('artboardUrl', () => {
  it('troca o canvas.json pelo arquivo da tela, mantendo o token', () => {
    expect(artboardUrl(CANVAS_URL, 'Pricing.html')).toBe(
      'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/tela/Pricing.html',
    )
  })

  it('codifica o nome e preserva subpasta', () => {
    expect(artboardUrl(CANVAS_URL, 'sub/Preços.html')).toBe(
      'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/tela/sub/Pre%C3%A7os.html',
    )
  })

  it('ignora query e hash da URL da peça', () => {
    expect(artboardUrl(`${CANVAS_URL}?r=1700000000`, 'Home.html')).toBe(
      'http://127.0.0.1:47821/api/file/design/dsg_abc123/tok-sign/tela/Home.html',
    )
  })

  it('sem canvas.json no fim, o arquivo entra na pasta em vez de comer o token', () => {
    expect(artboardUrl('http://host/api/file/design/dsg_abc/tok', 'Home.html')).toBe(
      'http://host/api/file/design/dsg_abc/tok/Home.html',
    )
  })

  it('URL sem pasta não endereça nada', () => {
    expect(artboardUrl('canvas.json', 'Home.html')).toBeNull()
    expect(artboardUrl(CANVAS_URL, '')).toBeNull()
  })
})

describe('screenLabel', () => {
  it('usa o título do índice e, sem ele, o nome do arquivo', () => {
    expect(screenLabel({ file: 'Home.html', title: 'Início' })).toBe('Início')
    expect(screenLabel({ file: 'sub/Pricing.html' })).toBe('Pricing')
    expect(screenLabel({ file: 'Signup.htm' })).toBe('Signup')
    expect(screenLabel({ file: 'Signup.html', title: '   ' })).toBe('Signup')
  })
})

describe('DesignViewer', () => {
  it('busca o canvas e abre a primeira tela', async () => {
    const fetchMock = stubFetch({})

    render(<DesignViewer piece={PIECE} />)

    expect(screen.getByTestId('design-loading')).toBeTruthy()

    await waitFor(() => expect(counter()).toBe('1 / 3'))
    expect(fetchMock).toHaveBeenCalledWith(CANVAS_URL, expect.anything())
    expect(currentUri()).toBe(`${CANVAS_URL.slice(0, -'canvas.json'.length)}Home.html`)
    // A tela aberta é a que a barra do host anuncia.
    expect(lastWebView().accessibilityLabel).toBe('Home')
  })

  it('as setas andam uma tela por vez e param nas pontas', async () => {
    stubFetch({})
    render(<DesignViewer piece={PIECE} />)
    await waitFor(() => expect(counter()).toBe('1 / 3'))

    // No começo não há para onde voltar: a seta não muda nada.
    fireEvent.click(screen.getByTestId('design-prev'))
    expect(counter()).toBe('1 / 3')

    fireEvent.click(screen.getByTestId('design-next'))
    expect(counter()).toBe('2 / 3')
    expect(currentUri()).toContain('/Pricing.html')

    fireEvent.click(screen.getByTestId('design-next'))
    expect(counter()).toBe('3 / 3')
    expect(currentUri()).toContain('/Signup.html')

    // Na última, a próxima não passa do fim.
    fireEvent.click(screen.getByTestId('design-next'))
    expect(counter()).toBe('3 / 3')
    expect(currentUri()).toContain('/Signup.html')

    fireEvent.click(screen.getByTestId('design-prev'))
    expect(counter()).toBe('2 / 3')
    expect(currentUri()).toContain('/Pricing.html')
  })

  it('a tira de telas pula direto para a tela escolhida', async () => {
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

  it('uma tela por vez: o WebView da anterior é desmontado', async () => {
    stubFetch({})
    render(<DesignViewer piece={PIECE} />)
    await waitFor(() => expect(counter()).toBe('1 / 3'))

    fireEvent.click(screen.getByTestId('design-next'))
    const mounted = screen.getAllByTestId('piece-view')
    expect(mounted).toHaveLength(1)
    expect(currentUri()).toContain('/Pricing.html')
  })

  it('erro ao buscar o canvas: caixa de erro e "tentar de novo" que refaz a busca', async () => {
    // Token vencido/desktop fora: a primeira busca falha, a segunda (o retry)
    // acha o índice.
    const fetchMock = stubFetch({ ok: false, status: 401 }, {})
    render(<DesignViewer piece={PIECE} />)

    expect(await screen.findByTestId('design-error')).toBeTruthy()
    expect(screen.getByText('HTTP 401')).toBeTruthy()
    // Nada de WebView apontando para o JSON.
    expect(webviews).toHaveLength(0)

    fireEvent.click(screen.getByTestId('design-retry'))
    await waitFor(() => expect(counter()).toBe('1 / 3'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('JSON malformado cai no erro, não em tela vazia nem quebrada', async () => {
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

  it('canvas sem telas mostra o estado vazio, sem WebView', async () => {
    stubFetch({ json: async () => canvas([], {}) })
    render(<DesignViewer piece={PIECE} />)

    expect(await screen.findByTestId('design-empty')).toBeTruthy()
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(screen.queryByTestId('design-counter')).toBeNull()
    expect(screen.queryByTestId('design-screens')).toBeNull()
  })

  it('uma tela que falha não derruba as outras nem a navegação', async () => {
    stubFetch({})
    render(<DesignViewer piece={PIECE} />)
    await waitFor(() => expect(counter()).toBe('1 / 3'))

    // A resposta HTTP da primeira artboard falhou: o host mostra o erro, e o
    // erro fica daquela tela.
    act(() => {
      ;(lastWebView().onHttpError as (event: unknown) => void)({ nativeEvent: { statusCode: 404 } })
    })
    expect(screen.getByText('parts.preview.error')).toBeTruthy()
    expect(counter()).toBe('1 / 3')

    fireEvent.click(screen.getByTestId('design-next'))
    await waitFor(() => expect(counter()).toBe('2 / 3'))
    expect(currentUri()).toContain('/Pricing.html')
    expect(screen.queryByText('parts.preview.error')).toBeNull()

    // E a que falhou continua na tira, para voltar depois (o host tem o retry).
    fireEvent.click(screen.getByTestId('design-screen-0'))
    expect(counter()).toBe('1 / 3')
    expect(currentUri()).toContain('/Home.html')
  })

  it('desmontar no meio da busca não estoura', async () => {
    stubFetch({})
    const view = render(<DesignViewer piece={PIECE} />)
    view.unmount()
    await Promise.resolve()
    expect(webviews).toHaveLength(0)
  })
})
