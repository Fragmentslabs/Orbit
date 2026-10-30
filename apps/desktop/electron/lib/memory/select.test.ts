/**
 * Selection for the context: candidates (semantic/lexical/fusion) and the two-level
 * policy. Synthetic vectors, no model — what is tested here is the rule.
 */
import { describe, expect, it } from 'vitest'
import type { Memory } from '@shared/memory'
import { Bm25Index, lexicalDocOf } from '@shared/memory-retrieval'
import {
  DEFAULT_RETRIEVAL,
  DEFAULT_SELECTION,
  NOISE_PROBES,
  noiseFloorOf,
  quantile,
  queryTokenCount,
  retrieveCandidates,
  selectForContext,
  type Candidate,
  type SelectionParams,
} from '@shared/memory-select'

const vec = (...xs: number[]) => Float32Array.from(xs)
const unit = (x: number, y: number) => {
  const n = Math.hypot(x, y)
  return vec(x / n, y / n, 0)
}

const mem = (id: string, text: string, tags: string[] = []): Memory => ({
  id,
  kind: 'general',
  text,
  tags,
  weight: 0.7,
  hits: 0,
  relatedIds: [],
  createdAt: 0,
})

const pool = [
  mem('a', 'Prefere assento no corredor e só mala de mão.', ['voo']),
  mem('b', 'Gosta de jazz e compra discos de vinil.', ['música']),
  mem('c', 'O projeto Atlas usa Next.js e roda testes com Vitest.', ['projeto']),
]
const lexical = new Bm25Index(pool.map((m) => lexicalDocOf(m)))

const cand = (id: string, cos: number | null, coverage = 0): Candidate => ({
  id,
  cos,
  semRank: null,
  bm25: 0,
  coverage,
  lexRank: null,
  fused: 0,
})

describe('candidatos', () => {
  it('semantic mode sorts by cosine and ignores the lexicon', () => {
    const vectors = new Map([
      ['a', unit(1, 0)],
      ['b', unit(0, 1)],
    ])
    const out = retrieveCandidates(
      { queryVec: unit(1, 0), lexicalQuery: 'vinil', vectors, lexical },
      { ...DEFAULT_RETRIEVAL, mode: 'semantic' },
    )
    expect(out[0].id).toBe('a')
    expect(out[0].cos).toBeCloseTo(1, 5)
    // "vinil" only exists in b, but the semantic mode does not query BM25
    expect(out.find((c) => c.id === 'b')?.coverage).toBe(0)
  })

  it('lexical mode works with no vector at all (app fallback)', () => {
    const out = retrieveCandidates(
      { queryVec: null, lexicalQuery: 'vinil', vectors: new Map(), lexical },
      { ...DEFAULT_RETRIEVAL, mode: 'hybrid' },
    )
    expect(out.map((c) => c.id)).toEqual(['b'])
    expect(out[0].cos).toBeNull()
  })

  it('the fusion brings a candidate only one of the sources found', () => {
    const vectors = new Map([
      ['a', unit(1, 0)],
      ['b', unit(0, 1)],
      ['c', unit(-1, 0)],
    ])
    const out = retrieveCandidates(
      { queryVec: unit(1, 0), lexicalQuery: 'vitest', vectors, lexical },
      DEFAULT_RETRIEVAL,
    )
    expect(out.map((c) => c.id)).toContain('a')
    expect(out.map((c) => c.id)).toContain('c')
  })

  it('coverage stays in 0..1 even when the BM25 saturates', () => {
    const out = retrieveCandidates(
      { queryVec: null, lexicalQuery: 'vinil jazz', vectors: new Map(), lexical },
      { ...DEFAULT_RETRIEVAL, mode: 'lexical' },
    )
    for (const c of out) {
      expect(c.coverage).toBeGreaterThanOrEqual(0)
      expect(c.coverage).toBeLessThanOrEqual(1)
    }
    expect(out[0].coverage).toBeCloseTo(1, 5)
  })

  it('an empty query does not invent a candidate', () => {
    const out = retrieveCandidates(
      { queryVec: null, lexicalQuery: '   ', vectors: new Map(), lexical },
      DEFAULT_RETRIEVAL,
    )
    expect(out).toEqual([])
  })
})

describe('corpus noise floor', () => {
  it('keeps the highest cosine of each probe, in order', () => {
    const vectors = new Map([
      ['a', unit(1, 0)],
      ['b', unit(0, 1)],
    ])
    const floor = noiseFloorOf([unit(1, 0), unit(0, 1)], vectors)
    expect(floor.tops).toEqual([1, 1])
  })

  it('the quantile interpolates and tolerates an empty list', () => {
    expect(quantile([], 1)).toBe(0)
    expect(quantile([0, 1], 0.5)).toBe(0.5)
    expect(quantile([0, 0.5, 1], 1)).toBe(1)
  })

  it('a corpus with high noise raises the injection threshold', () => {
    const quiet = selectForContext([cand('a', 0.45)], { tops: [0.1] }, { ...DEFAULT_SELECTION, threshold: 'collection', injectDelta: 0.05 })
    const noisy = selectForContext([cand('a', 0.45)], { tops: [0.42] }, { ...DEFAULT_SELECTION, threshold: 'collection', injectDelta: 0.05 })
    expect(quiet.inject.map((c) => c.id)).toEqual(['a'])
    expect(noisy.inject).toEqual([])
  })

  it('the noise probes do not repeat the benchmark queries', async () => {
    // the calibration set is written separately on purpose
    const cases = (await import('./bench/cases.json', { with: { type: 'json' } })).default as {
      cases: unknown[][]
      columns: string[]
    }
    const textIndex = cases.columns.indexOf('text')
    const texts = new Set(cases.cases.map((row) => String(row[textIndex]).trim().toLowerCase()))
    for (const probe of NOISE_PROBES) expect(texts.has(probe.trim().toLowerCase())).toBe(false)
  })
})

describe('two-tier policy', () => {
  const absolute = (over: Partial<SelectionParams> = {}): SelectionParams => ({
    ...DEFAULT_SELECTION,
    threshold: 'absolute',
    ...over,
  })

  it('high confidence injects the content', () => {
    const sel = selectForContext([cand('a', 0.82)], undefined, absolute())
    expect(sel.inject.map((c) => c.id)).toEqual(['a'])
    expect(sel.pointers).toEqual([])
  })

  it('medium confidence becomes a pointer, not an injection', () => {
    const sel = selectForContext([cand('a', 0.55)], undefined, absolute())
    expect(sel.inject).toEqual([])
    expect(sel.pointers.map((c) => c.id)).toEqual(['a'])
  })

  it('with no evidence it returns nothing', () => {
    const sel = selectForContext([cand('a', 0.2)], undefined, absolute())
    expect(sel.inject).toEqual([])
    expect(sel.pointers).toEqual([])
  })

  it('a weak first place does not become an injection just for being first', () => {
    const sel = selectForContext([cand('a', 0.58), cand('b', 0.57)], undefined, absolute())
    expect(sel.inject).toEqual([])
  })

  it('limits the number of injections and pointers', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => cand(id, 0.9))
    const sel = selectForContext(many, undefined, absolute({ maxInject: 2, maxPointers: 1, gap: 1 }))
    expect(sel.inject).toHaveLength(2)
    expect(sel.pointers).toHaveLength(1)
  })

  it('only injects what is near the top', () => {
    const sel = selectForContext([cand('a', 0.9), cand('b', 0.65)], undefined, absolute({ gap: 0.08 }))
    expect(sel.inject.map((c) => c.id)).toEqual(['a'])
    // 0.65 is still plausible: becomes a pointer
    expect(sel.pointers.map((c) => c.id)).toEqual(['b'])
  })

  it('a strong lexical match alone becomes a pointer', () => {
    const sel = selectForContext([cand('c', null, 1)], undefined, absolute({ lexPointerCoverage: 0.9 }))
    expect(sel.inject).toEqual([])
    expect(sel.pointers.map((c) => c.id)).toEqual(['c'])
  })

  it('pointer cosine + high lexical coverage injects', () => {
    const sel = selectForContext([cand('c', 0.62, 1)], undefined, absolute({ lexInjectCoverage: 0.9 }))
    expect(sel.inject.map((c) => c.id)).toEqual(['c'])
  })

  it('the margin over the second candidate can block the top injection', () => {
    const params = absolute({ minMargin: 0.2 })
    const tied = selectForContext([cand('a', 0.9), cand('b', 0.89)], undefined, params)
    const clear = selectForContext([cand('a', 0.9), cand('b', 0.5)], undefined, params)
    expect(tied.inject).toEqual([])
    expect(clear.inject.map((c) => c.id)).toEqual(['a'])
  })

  it('reporta os limiares efetivamente usados', () => {
    const sel = selectForContext([cand('a', 0.9)], { tops: [0.3] }, { ...DEFAULT_SELECTION, threshold: 'collection', injectDelta: 0.05, pointerDelta: 0 })
    expect(sel.thresholds.inject).toBeCloseTo(0.35, 5)
    expect(sel.thresholds.pointer).toBeCloseTo(0.3, 5)
  })
})

describe('custo da consulta', () => {
  it('counts tokens to decide whether the lexical search is worth it', () => {
    expect(queryTokenCount('E quanto custaria?')).toBe(2)
    expect(queryTokenCount('')).toBe(0)
  })
})
