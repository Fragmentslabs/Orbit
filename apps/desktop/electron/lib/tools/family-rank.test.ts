import { describe, expect, it } from 'vitest'
import type { ToolFamily } from './catalog'
import { FAMILY_RANK, familyDocText, familySetSignature, rankFamilies, rankableFamilies } from './family-rank'

// Unit vectors on the axes: cosine 1 with itself, 0 with the others.
const docs = [
  { id: 'pdf', vec: [1, 0, 0] },
  { id: 'video', vec: [0, 1, 0] },
  { id: 'mail', vec: [0, 0, 1] },
]
const noise = (...tops: number[]) => ({ tops: [...tops].sort((a, b) => a - b) })

describe('rankFamilies', () => {
  it('selects nothing without a noise floor (the safe fallback)', () => {
    expect(rankFamilies([1, 0, 0], docs, undefined)).toEqual({ hits: [], threshold: null })
    expect(rankFamilies([1, 0, 0], docs, { tops: [] }).hits).toEqual([])
  })

  it('threshold is the collection floor plus the delta, not a constant', () => {
    const low = rankFamilies([1, 0, 0], docs, noise(0.1, 0.2))
    const high = rankFamilies([1, 0, 0], docs, noise(0.3, 0.99))
    expect(low.threshold).toBeCloseTo(0.2 + FAMILY_RANK.delta)
    expect(high.threshold).toBeCloseTo(0.99 + FAMILY_RANK.delta)
    // The same query clears the low floor and not the high one.
    expect(low.hits.map((h) => h.id)).toEqual(['pdf'])
    expect(high.hits).toEqual([])
  })

  it('keeps only families within the gap of the best one, up to the max', () => {
    const q = [0.7, 0.7, 0] // equidistant from pdf and video
    const ranked = rankFamilies(q, docs, noise(0.1), { ...FAMILY_RANK, max: 5 })
    expect(ranked.hits.map((h) => h.id)).toEqual(['pdf', 'video'])
    const capped = rankFamilies(q, docs, noise(0.1), { ...FAMILY_RANK, max: 1 })
    expect(capped.hits).toHaveLength(1)
    const far = rankFamilies([1, 0.5, 0], docs, noise(0.1), { ...FAMILY_RANK, gap: 0.05 })
    expect(far.hits.map((h) => h.id)).toEqual(['pdf'])
  })

  it('orders ties by id so the result is deterministic', () => {
    const tie = rankFamilies([1, 1, 0], docs, noise(0.1), { ...FAMILY_RANK, delta: 0, gap: 1, max: 3 })
    expect(tie.hits.map((h) => h.id).slice(0, 2)).toEqual(['pdf', 'video'])
  })
})

const family = (over: Partial<ToolFamily>): ToolFamily => ({
  id: 'f',
  label: 'F',
  description: 'does f',
  tools: ['f_one'],
  ...over,
})

describe('families as documents', () => {
  it('document text carries label, description and tags — not tool names', () => {
    const text = familyDocText(family({ label: 'pdf', description: 'Read PDFs.', tags: ['pdf', 'pagina'], tools: ['pdf_view'] }))
    expect(text).toBe('pdf. Read PDFs. pdf, pagina.')
    expect(text).not.toContain('pdf_view')
  })

  it('only available, non-MCP, not-yet-active families are rankable', () => {
    const list = [
      family({ id: 'a' }),
      family({ id: 'b', unavailable: 'code mode only', tools: [] }),
      family({ id: 'c', mcp: true }),
      family({ id: 'd' }),
      family({ id: 'e', tools: [] }),
    ]
    expect(rankableFamilies(list, new Set(['d'])).map((f) => f.id)).toEqual(['a'])
  })

  it('set signature ignores order and changes with any text', () => {
    expect(familySetSignature(['a', 'b'])).toBe(familySetSignature(['b', 'a']))
    expect(familySetSignature(['a', 'b'])).not.toBe(familySetSignature(['a', 'c']))
  })
})
