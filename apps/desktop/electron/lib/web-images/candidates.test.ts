import { beforeEach, describe, expect, it } from 'vitest'
import {
  candidateId,
  clearCandidates,
  recallCandidate,
  rememberCandidates,
  searchPageUrl,
  toCandidates,
} from './candidates'

const PAGE = 'https://dribbble.com/search/fintech'

describe('toCandidates', () => {
  it('makes addresses absolute and keeps the link the picture sits in as its page', () => {
    const [c] = toCandidates([{ src: '/img/a.jpg', href: '/shots/1-a', alt: ' A  shot ', width: 400, height: 300 }], PAGE)
    expect(c.imageUrl).toBe('https://dribbble.com/img/a.jpg')
    expect(c.pageUrl).toBe('https://dribbble.com/shots/1-a')
    expect(c.host).toBe('dribbble.com')
    expect(c.title).toBe('A shot')
    expect(c.id).toBe(candidateId('https://dribbble.com/img/a.jpg'))
  })

  it('falls back to the page being read when the picture is not inside a link', () => {
    const [c] = toCandidates([{ src: 'https://cdn.x.com/a.png' }], PAGE)
    expect(c.pageUrl).toBe(PAGE)
  })

  it('drops chrome: small, svg, logos, avatars, non-https, local network, repeats', () => {
    const out = toCandidates(
      [
        { src: 'https://x.com/a.jpg', width: 40, height: 40 },
        { src: 'https://x.com/a.svg' },
        { src: 'https://x.com/assets/logo.png' },
        { src: 'https://x.com/u/avatar_1.jpg' },
        { src: 'http://x.com/a.jpg' },
        { src: 'https://192.168.0.2/a.jpg' },
        { src: 'data:image/png;base64,AAAA' },
        { src: 'https://x.com/ok.jpg', width: 300, height: 200 },
        { src: 'https://x.com/ok.jpg', width: 300, height: 200 },
      ],
      PAGE,
    )
    expect(out.map((c) => c.imageUrl)).toEqual(['https://x.com/ok.jpg'])
  })

  it('keeps the search engine thumbnail as the alternative address and honors the limit', () => {
    const raw = Array.from({ length: 5 }, (_, i) => ({ src: `https://x.com/${i}.jpg`, thumb: `https://tse.mm.bing.net/${i}` }))
    const out = toCandidates(raw, 'https://www.bing.com/images/search?q=x', 3)
    expect(out).toHaveLength(3)
    expect(out[0].fallbackUrl).toBe('https://tse.mm.bing.net/0')
  })
})

describe('searchPageUrl', () => {
  it('opens each site\'s own search page', () => {
    expect(searchPageUrl('fintech app', 'dribbble')).toBe('https://dribbble.com/search/fintech-app')
    expect(searchPageUrl('dark ui', 'behance')).toContain('behance.net/search/projects?search=dark%20ui')
    expect(searchPageUrl('dark ui', 'pinterest')).toContain('pinterest.com/search/pins/?q=dark%20ui')
    expect(searchPageUrl('Kendrick Lamar', 'any')).toContain('bing.com/images/search?q=Kendrick%20Lamar')
  })
})

describe('candidate memory', () => {
  beforeEach(clearCandidates)

  it('remembers by id and forgets after the ttl', () => {
    const [c] = toCandidates([{ src: 'https://x.com/a.jpg' }], PAGE)
    rememberCandidates([c], 1_000)
    expect(recallCandidate(c.id, 2_000)?.imageUrl).toBe('https://x.com/a.jpg')
    expect(recallCandidate(c.id, 1_000 + 3 * 60 * 60 * 1000)).toBeNull()
    expect(recallCandidate('web:unknown')).toBeNull()
  })
})
