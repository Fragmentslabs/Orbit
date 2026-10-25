/**
 * Seleção para o contexto: candidatos (semântico/lexical/fusão) e a política de
 * dois níveis. Vetores sintéticos, sem modelo — o que se testa aqui é a regra.
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
  it('modo semântico ordena por cosseno e ignora o léxico', () => {
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
    // "vinil" só existe em b, mas o modo semântico não consulta o BM25
    expect(out.find((c) => c.id === 'b')?.coverage).toBe(0)
  })

  it('modo lexical funciona sem vetor nenhum (fallback do app)', () => {
    const out = retrieveCandidates(
      { queryVec: null, lexicalQuery: 'vinil', vectors: new Map(), lexical },
      { ...DEFAULT_RETRIEVAL, mode: 'hybrid' },
    )
    expect(out.map((c) => c.id)).toEqual(['b'])
    expect(out[0].cos).toBeNull()
  })

  it('a fusão traz candidato que só uma das fontes achou', () => {
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

  it('cobertura fica em 0..1 mesmo quando o BM25 satura', () => {
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

  it('consulta vazia não inventa candidato', () => {
    const out = retrieveCandidates(
      { queryVec: null, lexicalQuery: '   ', vectors: new Map(), lexical },
      DEFAULT_RETRIEVAL,
    )
    expect(out).toEqual([])
  })
})

describe('piso de ruído do acervo', () => {
  it('guarda o maior cosseno de cada sonda, em ordem', () => {
    const vectors = new Map([
      ['a', unit(1, 0)],
      ['b', unit(0, 1)],
    ])
    const floor = noiseFloorOf([unit(1, 0), unit(0, 1)], vectors)
    expect(floor.tops).toEqual([1, 1])
  })

  it('quantil interpola e tolera lista vazia', () => {
    expect(quantile([], 1)).toBe(0)
    expect(quantile([0, 1], 0.5)).toBe(0.5)
    expect(quantile([0, 0.5, 1], 1)).toBe(1)
  })

  it('acervo com ruído alto eleva o limiar de injeção', () => {
    const quiet = selectForContext([cand('a', 0.45)], { tops: [0.1] }, { ...DEFAULT_SELECTION, threshold: 'acervo', injectDelta: 0.05 })
    const noisy = selectForContext([cand('a', 0.45)], { tops: [0.42] }, { ...DEFAULT_SELECTION, threshold: 'acervo', injectDelta: 0.05 })
    expect(quiet.inject.map((c) => c.id)).toEqual(['a'])
    expect(noisy.inject).toEqual([])
  })

  it('as sondas de ruído não repetem as consultas do benchmark', async () => {
    // o conjunto de calibração é escrito à parte de propósito
    const cases = (await import('./bench/cases.json', { with: { type: 'json' } })).default as {
      cases: unknown[][]
      columns: string[]
    }
    const textIndex = cases.columns.indexOf('text')
    const texts = new Set(cases.cases.map((row) => String(row[textIndex]).trim().toLowerCase()))
    for (const probe of NOISE_PROBES) expect(texts.has(probe.trim().toLowerCase())).toBe(false)
  })
})

describe('política de dois níveis', () => {
  const absolute = (over: Partial<SelectionParams> = {}): SelectionParams => ({
    ...DEFAULT_SELECTION,
    threshold: 'absolute',
    ...over,
  })

  it('confiança alta injeta o conteúdo', () => {
    const sel = selectForContext([cand('a', 0.82)], undefined, absolute())
    expect(sel.inject.map((c) => c.id)).toEqual(['a'])
    expect(sel.pointers).toEqual([])
  })

  it('confiança média vira ponteiro, não injeção', () => {
    const sel = selectForContext([cand('a', 0.55)], undefined, absolute())
    expect(sel.inject).toEqual([])
    expect(sel.pointers.map((c) => c.id)).toEqual(['a'])
  })

  it('sem evidência não devolve nada', () => {
    const sel = selectForContext([cand('a', 0.2)], undefined, absolute())
    expect(sel.inject).toEqual([])
    expect(sel.pointers).toEqual([])
  })

  it('primeiro lugar fraco não vira injeção só por estar em primeiro', () => {
    const sel = selectForContext([cand('a', 0.58), cand('b', 0.57)], undefined, absolute())
    expect(sel.inject).toEqual([])
  })

  it('limita a quantidade de injeções e de ponteiros', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) => cand(id, 0.9))
    const sel = selectForContext(many, undefined, absolute({ maxInject: 2, maxPointers: 1, gap: 1 }))
    expect(sel.inject).toHaveLength(2)
    expect(sel.pointers).toHaveLength(1)
  })

  it('só injeta quem está perto do topo', () => {
    const sel = selectForContext([cand('a', 0.9), cand('b', 0.65)], undefined, absolute({ gap: 0.08 }))
    expect(sel.inject.map((c) => c.id)).toEqual(['a'])
    // 0.65 ainda é plausível: vira ponteiro
    expect(sel.pointers.map((c) => c.id)).toEqual(['b'])
  })

  it('correspondência lexical forte sozinha vira ponteiro', () => {
    const sel = selectForContext([cand('c', null, 1)], undefined, absolute({ lexPointerCoverage: 0.9 }))
    expect(sel.inject).toEqual([])
    expect(sel.pointers.map((c) => c.id)).toEqual(['c'])
  })

  it('cosseno de ponteiro + cobertura lexical alta injeta', () => {
    const sel = selectForContext([cand('c', 0.62, 1)], undefined, absolute({ lexInjectCoverage: 0.9 }))
    expect(sel.inject.map((c) => c.id)).toEqual(['c'])
  })

  it('margem sobre o segundo candidato pode bloquear a injeção do topo', () => {
    const params = absolute({ minMargin: 0.2 })
    const tied = selectForContext([cand('a', 0.9), cand('b', 0.89)], undefined, params)
    const clear = selectForContext([cand('a', 0.9), cand('b', 0.5)], undefined, params)
    expect(tied.inject).toEqual([])
    expect(clear.inject.map((c) => c.id)).toEqual(['a'])
  })

  it('reporta os limiares efetivamente usados', () => {
    const sel = selectForContext([cand('a', 0.9)], { tops: [0.3] }, { ...DEFAULT_SELECTION, threshold: 'acervo', injectDelta: 0.05, pointerDelta: 0 })
    expect(sel.thresholds.inject).toBeCloseTo(0.35, 5)
    expect(sel.thresholds.pointer).toBeCloseTo(0.3, 5)
  })
})

describe('custo da consulta', () => {
  it('conta tokens para decidir se a busca lexical vale a pena', () => {
    expect(queryTokenCount('E quanto custaria?')).toBe(2)
    expect(queryTokenCount('')).toBe(0)
  })
})
