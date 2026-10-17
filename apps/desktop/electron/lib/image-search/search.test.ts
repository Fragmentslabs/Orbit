import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptable, commonsUrl, interleave, openverseUrl, searchImages, USER_AGENT } from './search'
import type { Fetcher, SearchOptions } from './types'

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')

const opts = (over: Partial<SearchOptions> = {}): SearchOptions => ({
  query: 'lion',
  limit: 6,
  license: 'commercial',
  providers: ['commons', 'openverse'],
  minWidth: 800,
  ...over,
})

/** Um fetch falso que responde por host e guarda o que foi pedido. */
function fake(routes: { commons?: () => Response; openverse?: () => Response }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    if (url.includes('wikimedia')) return routes.commons?.() ?? new Response('', { status: 500 })
    return routes.openverse?.() ?? new Response('', { status: 500 })
  }
  return { fetcher, calls }
}
const json = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'application/json' } })

describe('URLs dos pedidos', () => {
  it('Commons: só bitmap, pasta de arquivos, tamanho pedido e origin', () => {
    const url = new URL(commonsUrl(opts()))
    expect(url.origin + url.pathname).toBe('https://commons.wikimedia.org/w/api.php')
    expect(url.searchParams.get('gsrsearch')).toBe('lion filetype:bitmap')
    expect(url.searchParams.get('gsrnamespace')).toBe('6')
    expect(url.searchParams.get('iiurlwidth')).toBe('1920')
    expect(url.searchParams.get('iiprop')).toContain('extmetadata')
  })

  it('Openverse: sem conteúdo adulto, e licença/orientação viram parâmetros nativos', () => {
    const base = new URL(openverseUrl(opts()))
    expect(base.searchParams.get('mature')).toBe('false')
    expect(base.searchParams.get('license_type')).toBe('commercial')
    expect(new URL(openverseUrl(opts({ license: 'public-domain' }))).searchParams.get('license')).toBe('cc0,pdm')
    expect(new URL(openverseUrl(opts({ license: 'any' }))).searchParams.has('license_type')).toBe(false)
    expect(new URL(openverseUrl(opts({ orientation: 'landscape' }))).searchParams.get('aspect_ratio')).toBe('wide')
    expect(new URL(openverseUrl(opts({ orientation: 'portrait' }))).searchParams.get('aspect_ratio')).toBe('tall')
  })
})

describe('searchImages', () => {
  it('junta os dois, intercala, filtra a licença e identifica o app (a Wikimedia exige)', async () => {
    const { fetcher, calls } = fake({ commons: json(fixture('commons.json')), openverse: json(fixture('openverse.json')) })
    const { results, warnings } = await searchImages(opts({ limit: 10, minWidth: 500 }), fetcher)
    expect(warnings).toEqual([])
    // 3 do Commons + 2 do Openverse (a terceira é NC/ND e sai no filtro comercial).
    expect(results).toHaveLength(5)
    expect(results.some((r) => r.credit.license.includes('NC'))).toBe(false)
    expect(results.slice(0, 2).map((r) => r.provider)).toEqual(['commons', 'openverse'])
    for (const call of calls) expect(call.headers['User-Agent']).toBe(USER_AGENT)
  })

  it('"any" deixa passar a licença restritiva', async () => {
    const { fetcher } = fake({ commons: json('{}'), openverse: json(fixture('openverse.json')) })
    const { results } = await searchImages(opts({ license: 'any', providers: ['openverse'], minWidth: 500 }), fetcher)
    expect(results.some((r) => r.credit.license === 'CC BY-NC-ND 2.0')).toBe(true)
  })

  it('um provedor limitado (429) vira aviso, e o outro segue valendo', async () => {
    const { fetcher } = fake({ commons: json(fixture('commons.json')), openverse: json('{}', 429) })
    const { results, warnings } = await searchImages(opts({ minWidth: 500 }), fetcher)
    expect(results.length).toBeGreaterThan(0)
    expect(warnings).toEqual(['Openverse: rate limit reached — try again in a minute'])
  })

  it('os dois falhando: nenhum resultado, os dois avisos', async () => {
    const { fetcher } = fake({})
    const { results, warnings } = await searchImages(opts(), fetcher)
    expect(results).toEqual([])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('failed (500)')
  })

  it('erro de rede também é só um aviso', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('offline')
    }
    const { results, warnings } = await searchImages(opts({ providers: ['commons'] }), fetcher)
    expect(results).toEqual([])
    expect(warnings).toEqual(['Wikimedia Commons: offline'])
  })

  it('respeita o limite e não repete o mesmo arquivo vindo dos dois', async () => {
    const { fetcher } = fake({ commons: json(fixture('commons.json')), openverse: json(fixture('openverse.json')) })
    const { results } = await searchImages(opts({ limit: 2, minWidth: 500 }), fetcher)
    expect(results).toHaveLength(2)
    const dup = fixture('commons.json')
    const twice = fake({ commons: json(dup), openverse: json(JSON.stringify({ results: [] })) })
    const { results: unique } = await searchImages(opts({ limit: 10, providers: ['commons', 'commons'], minWidth: 500 }), twice.fetcher)
    expect(new Set(unique.map((r) => r.credit.sourceUrl)).size).toBe(unique.length)
  })
})

describe('provedor lento', () => {
  it('o Openverse acima de 20 por página seria recusado: o pedido nunca passa de 20', () => {
    expect(new URL(openverseUrl(opts({ limit: 12 }))).searchParams.get('page_size')).toBe('20')
    expect(new URL(openverseUrl(opts({ limit: 2 }))).searchParams.get('page_size')).toBe('6')
  })

  it('depois que um provedor trouxe resultados, o lento tem só a janela de espera — e vira aviso', async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes('wikimedia')) return new Response(fixture('commons.json'), { status: 200 })
      await new Promise((resolve) => setTimeout(resolve, 500))
      return new Response(fixture('openverse.json'), { status: 200 })
    }
    const started = Date.now()
    const { results, warnings } = await searchImages(opts({ minWidth: 500 }), fetcher, 50)
    expect(Date.now() - started).toBeLessThan(400)
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.provider === 'commons')).toBe(true)
    expect(warnings).toEqual(['Openverse: too slow — repeat the search to include it'])
  })

  it('se o lento chega dentro da janela, entra normalmente', async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes('wikimedia')) return new Response(fixture('commons.json'), { status: 200 })
      await new Promise((resolve) => setTimeout(resolve, 30))
      return new Response(fixture('openverse.json'), { status: 200 })
    }
    const { results, warnings } = await searchImages(opts({ minWidth: 500, limit: 10 }), fetcher, 500)
    expect(warnings).toEqual([])
    expect(results.some((r) => r.provider === 'openverse')).toBe(true)
  })

  it('sem nenhum resultado ainda, espera os dois responderem (não há o que entregar antes)', async () => {
    const fetcher: Fetcher = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, url.includes('wikimedia') ? 5 : 80))
      return url.includes('wikimedia') ? new Response('{}', { status: 200 }) : new Response(fixture('openverse.json'), { status: 200 })
    }
    const { results } = await searchImages(opts({ minWidth: 500 }), fetcher, 10)
    expect(results.some((r) => r.provider === 'openverse')).toBe(true)
  })
})

describe('acceptable', () => {
  const base = { id: 'x', provider: 'commons' as const, title: 't', thumbUrl: 'u', downloadUrl: 'u', credit: { license: 'CC BY 4.0', sourceUrl: 's', provider: 'commons' as const, attribution: 'a' } }

  it('largura mínima e orientação', () => {
    expect(acceptable({ ...base, width: 500, height: 400 }, opts({ minWidth: 800 }))).toBe(false)
    expect(acceptable({ ...base, width: 1600, height: 900 }, opts({ orientation: 'landscape' }))).toBe(true)
    expect(acceptable({ ...base, width: 900, height: 1600 }, opts({ orientation: 'landscape' }))).toBe(false)
    expect(acceptable({ ...base, width: 1000, height: 1000 }, opts({ orientation: 'square' }))).toBe(true)
    // Sem dimensões declaradas não dá para recusar por tamanho.
    expect(acceptable({ ...base }, opts({ orientation: 'portrait' }))).toBe(true)
  })
})

describe('interleave', () => {
  it('um de cada lista, na ordem, até acabar', () => {
    expect(interleave<number | string>([[1, 2, 3], ['a'], ['x', 'y']])).toEqual([1, 'a', 'x', 2, 'y', 3])
    expect(interleave([])).toEqual([])
  })
})
