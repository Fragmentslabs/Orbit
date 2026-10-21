import { describe, expect, it, vi } from 'vitest'

/** Mesmo molde do design-store.test.ts: `app`/`protocol` do main são mockados. */
const registered = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>(),
}))

vi.mock('electron', async () => {
  const nodePath = await import('node:path')
  const nodeOs = await import('node:os')
  const root = nodePath.join(nodeOs.tmpdir(), `orbit-fonts-test-${process.pid}`)
  return {
    app: { getPath: () => root },
    protocol: {
      registerSchemesAsPrivileged: () => {},
      handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
        registered.handlers.set(scheme, handler)
      },
    },
  }
})

const { addFont, fontFaceCss, listFonts, registerFontProtocol, storeFontFile } = await import('./store')
const { ensureFont, searchCatalog } = await import('./source')
const { familyOf } = await import('./system')

const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 1)])

/** Um `fetch` de mentira: o teste não toca a rede, mas passa pelas mesmas checagens. */
function fakeFetch(responses: (url: string) => Response | null) {
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const response = responses(url)
    if (!response) throw new Error(`unexpected url ${url}`)
    return response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('a biblioteca de fontes', () => {
  it('guarda o arquivo pelo hash: o mesmo byte não entra duas vezes', async () => {
    const first = await storeFontFile(WOFF2, 'woff2')
    const second = await storeFontFile(Buffer.from(WOFF2), 'woff2')
    const other = await storeFontFile(Buffer.concat([WOFF2, Buffer.from('x')]), 'woff2')
    expect(second).toBe(first)
    expect(other).not.toBe(first)
    expect(first).toMatch(/^[a-f0-9]{32}\.woff2$/)
  })

  it('serve o arquivo com CORS e recusa caminho fora do armazém', async () => {
    registerFontProtocol()
    const handler = registered.handlers.get('orbit-font')!
    const file = await storeFontFile(WOFF2, 'woff2')

    const ok = await handler(new Request(`orbit-font://f/${file}`))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('font/woff2')
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')

    expect((await handler(new Request('orbit-font://f/..%2F..%2Findex.json'))).status).toBe(404)
    expect((await handler(new Request(`orbit-font://f/${'a'.repeat(32)}.woff2`))).status).toBe(404)
  })

  it('monta o @font-face com a faixa de pesos e o unicode-range', () => {
    const css = fontFaceCss([
      {
        id: 'inter',
        family: 'Inter',
        variable: true,
        weights: ['100 900'],
        styles: ['normal'],
        subsets: ['latin'],
        files: [{ file: `${'b'.repeat(32)}.woff2`, subset: 'latin', weight: '100 900', style: 'normal', unicodeRange: 'U+0000-00FF' }],
        addedAt: 1,
      },
    ])
    expect(css).toContain("font-family: 'Inter';")
    expect(css).toContain('font-weight: 100 900;')
    expect(css).toContain(`url('orbit-font://f/${'b'.repeat(32)}.woff2')`)
    expect(css).toContain('unicode-range: U+0000-00FF;')
  })
})

describe('o catálogo', () => {
  const fonts = [
    { id: 'inter', family: 'Inter', subsets: ['latin'], weights: [400], styles: ['normal'], variable: true },
    { id: 'inter-tight', family: 'Inter Tight', subsets: ['latin'], weights: [400], styles: ['normal'], variable: true },
    { id: 'playfair-display', family: 'Playfair Display', subsets: ['latin'], weights: [400], styles: ['normal'], variable: true },
  ]

  it('põe o nome exato na frente de quem só contém o termo', () => {
    expect(searchCatalog(fonts, 'inter', 2).map((font) => font.id)).toEqual(['inter', 'inter-tight'])
    expect(searchCatalog(fonts, 'playfair', 1)[0].id).toBe('playfair-display')
    expect(searchCatalog(fonts, 'nada-disso', 5)).toEqual([])
  })
})

describe('instalar uma família', () => {
  it('baixa os subsets pedidos, registra no índice e não repete a rede', async () => {
    const { fetcher, calls } = fakeFetch((url) => {
      if (url.startsWith('https://api.fontsource.org/v1/fonts'))
        return json([
          {
            id: 'jetbrains-mono',
            family: 'JetBrains Mono',
            subsets: ['latin', 'latin-ext', 'cyrillic'],
            weights: [100, 400, 800],
            styles: ['normal', 'italic'],
            variable: true,
            category: 'monospace',
            license: 'OFL-1.1',
          },
        ])
      if (url.endsWith('/metadata.json'))
        return json({
          id: 'jetbrains-mono',
          family: 'JetBrains Mono',
          subsets: ['latin', 'latin-ext', 'cyrillic'],
          styles: ['normal', 'italic'],
          weights: [100, 400, 800],
          variable: { wght: { min: '100', max: '800' } },
          license: { type: 'OFL-1.1', url: 'https://openfontlicense.org' },
          category: 'monospace',
        })
      if (url.endsWith('/unicode.json')) return json({ latin: 'U+0000-00FF', 'latin-ext': 'U+0100-02BA' })
      if (url.endsWith('.woff2')) return new Response(WOFF2, { status: 200, headers: { 'content-type': 'font/woff2' } })
      return null
    })

    const font = await ensureFont('JetBrains Mono', {}, { fetcher })
    expect(font.family).toBe('JetBrains Mono')
    expect(font.variable).toBe(true)
    expect(font.weights).toEqual(['100 800'])
    expect(font.subsets).toEqual(['latin', 'latin-ext'])
    expect(font.license?.type).toBe('OFL-1.1')
    expect(font.files).toHaveLength(2)
    expect(await listFonts()).toHaveLength(1)

    const before = calls.length
    const again = await ensureFont('jetbrains-mono', {}, { fetcher })
    expect(again.id).toBe(font.id)
    expect(calls.length).toBe(before)
  })

  it('recusa um "woff2" que não é fonte', async () => {
    const { fetcher } = fakeFetch((url) => {
      if (url.startsWith('https://api.fontsource.org/v1/fonts'))
        return json([{ id: 'broken', family: 'Broken', subsets: ['latin'], weights: [400], styles: ['normal'], variable: false }])
      if (url.endsWith('/metadata.json'))
        return json({ id: 'broken', family: 'Broken', subsets: ['latin'], styles: ['normal'], weights: [400] })
      if (url.endsWith('/unicode.json')) return json({})
      if (url.endsWith('.woff2')) return new Response('<html>not found</html>', { status: 200 })
      return null
    })
    // `now` adiantado: força reler o catálogo em vez de usar o que o teste anterior gravou.
    const farFuture = () => Date.now() + 365 * 24 * 60 * 60 * 1000
    await expect(ensureFont('Broken', {}, { fetcher, now: farFuture })).rejects.toThrow(/could not download/)
  })
})

describe('o artboard', () => {
  it('recebe o @font-face da biblioteca ANTES do CSS do próprio board', async () => {
    const { injectDesignRuntime } = await import('../design/design-runtime')
    const html = '<html><head><title>x</title><style>body{color:red}</style></head><body></body></html>'
    const out = injectDesignRuntime(html, "@font-face{font-family:'Inter'}")
    expect(out).toContain('data-orbit-fonts')
    expect(out.indexOf('data-orbit-fonts')).toBeLessThan(out.indexOf('<style>body'))
    // Biblioteca vazia não injeta tag nenhuma.
    expect(injectDesignRuntime(html, '')).not.toContain('data-orbit-fonts')
  })
})

describe('as famílias do sistema', () => {
  it('tira o sufixo de estilo da entrada do registro', () => {
    expect(familyOf('Arial (TrueType)')).toBe('Arial')
    expect(familyOf('Segoe UI Semibold')).toBe('Segoe UI')
    expect(familyOf('Segoe UI Bold Italic')).toBe('Segoe UI')
    expect(familyOf('Playfair Display')).toBe('Playfair Display')
    expect(familyOf('Consolas Italic (TrueType)')).toBe('Consolas')
  })
})

describe('o índice', () => {
  it('troca a família quando o id se repete', async () => {
    const base = {
      id: 'inter',
      family: 'Inter',
      variable: true,
      weights: ['100 900'],
      styles: ['normal'],
      subsets: ['latin'],
      files: [],
      addedAt: 10,
    }
    await addFont(base)
    await addFont({ ...base, family: 'Inter Display' })
    const fonts = await listFonts()
    expect(fonts.filter((font) => font.id === 'inter')).toHaveLength(1)
    expect(fonts.find((font) => font.id === 'inter')?.family).toBe('Inter Display')
    // `addedAt` é preservado: reinstalar não "envelhece" a fonte.
    expect(fonts.find((font) => font.id === 'inter')?.addedAt).toBe(10)
  })
})
