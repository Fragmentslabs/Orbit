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

/** A fake fetch that answers by host and records what was requested. */
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

describe('request URLs', () => {
  it('Commons: bitmap only, files folder, requested size and origin', () => {
    const url = new URL(commonsUrl(opts()))
    expect(url.origin + url.pathname).toBe('https://commons.wikimedia.org/w/api.php')
    expect(url.searchParams.get('gsrsearch')).toBe('lion filetype:bitmap')
    expect(url.searchParams.get('gsrnamespace')).toBe('6')
    expect(url.searchParams.get('iiurlwidth')).toBe('1920')
    expect(url.searchParams.get('iiprop')).toContain('extmetadata')
  })

  it('Openverse: no adult content, and license/orientation become native parameters', () => {
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
  it('joins both, interleaves, filters the license and identifies the app (Wikimedia requires it)', async () => {
    const { fetcher, calls } = fake({ commons: json(fixture('commons.json')), openverse: json(fixture('openverse.json')) })
    const { results, warnings } = await searchImages(opts({ limit: 10, minWidth: 500 }), fetcher)
    expect(warnings).toEqual([])
    // 3 from Commons + 2 from Openverse (the third one is NC/ND and drops out in the commercial filter).
    expect(results).toHaveLength(5)
    expect(results.some((r) => r.credit.license.includes('NC'))).toBe(false)
    expect(results.slice(0, 2).map((r) => r.provider)).toEqual(['commons', 'openverse'])
    for (const call of calls) expect(call.headers['User-Agent']).toBe(USER_AGENT)
  })

  it('"any" lets the restrictive license through', async () => {
    const { fetcher } = fake({ commons: json('{}'), openverse: json(fixture('openverse.json')) })
    const { results } = await searchImages(opts({ license: 'any', providers: ['openverse'], minWidth: 500 }), fetcher)
    expect(results.some((r) => r.credit.license === 'CC BY-NC-ND 2.0')).toBe(true)
  })

  it('a rate-limited provider (429) becomes a warning, and the other still counts', async () => {
    const { fetcher } = fake({ commons: json(fixture('commons.json')), openverse: json('{}', 429) })
    const { results, warnings } = await searchImages(opts({ minWidth: 500 }), fetcher)
    expect(results.length).toBeGreaterThan(0)
    expect(warnings).toEqual(['Openverse: rate limit reached — try again in a minute'])
  })

  it('both failing: no result, both warnings', async () => {
    const { fetcher } = fake({})
    const { results, warnings } = await searchImages(opts(), fetcher)
    expect(results).toEqual([])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('failed (500)')
  })

  it('a network error is also just a warning', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('offline')
    }
    const { results, warnings } = await searchImages(opts({ providers: ['commons'] }), fetcher)
    expect(results).toEqual([])
    expect(warnings).toEqual(['Wikimedia Commons: offline'])
  })

  it('respects the limit and does not repeat the same file coming from both', async () => {
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
  it('Openverse above 20 per page would be refused: the request never passes 20', () => {
    expect(new URL(openverseUrl(opts({ limit: 12 }))).searchParams.get('page_size')).toBe('20')
    expect(new URL(openverseUrl(opts({ limit: 2 }))).searchParams.get('page_size')).toBe('6')
  })

  it('after a provider has brought results, the slow one only has the wait window — and becomes a warning', async () => {
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

  it('if the slow one arrives within the window, it goes in normally', async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes('wikimedia')) return new Response(fixture('commons.json'), { status: 200 })
      await new Promise((resolve) => setTimeout(resolve, 30))
      return new Response(fixture('openverse.json'), { status: 200 })
    }
    const { results, warnings } = await searchImages(opts({ minWidth: 500, limit: 10 }), fetcher, 500)
    expect(warnings).toEqual([])
    expect(results.some((r) => r.provider === 'openverse')).toBe(true)
  })

  it('with no result yet, it waits for both to answer (there is nothing to deliver before)', async () => {
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

  it('minimum width and orientation', () => {
    expect(acceptable({ ...base, width: 500, height: 400 }, opts({ minWidth: 800 }))).toBe(false)
    expect(acceptable({ ...base, width: 1600, height: 900 }, opts({ orientation: 'landscape' }))).toBe(true)
    expect(acceptable({ ...base, width: 900, height: 1600 }, opts({ orientation: 'landscape' }))).toBe(false)
    expect(acceptable({ ...base, width: 1000, height: 1000 }, opts({ orientation: 'square' }))).toBe(true)
    // With no declared dimensions it is not possible to refuse it by size.
    expect(acceptable({ ...base }, opts({ orientation: 'portrait' }))).toBe(true)
  })
})

describe('interleave', () => {
  it('one from each list, in order, until they run out', () => {
    expect(interleave<number | string>([[1, 2, 3], ['a'], ['x', 'y']])).toEqual([1, 'a', 'x', 2, 'y', 3])
    expect(interleave([])).toEqual([])
  })
})
