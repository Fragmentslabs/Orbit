/**
 * Pure retrieval layer (packages/shared/memory-retrieval): index
 * text, Unicode tokens, BM25 and RRF. Nothing here depends on a model — it is the part
 * that guarantees the lexical fallback and that the app and the benchmark share.
 */
import { describe, expect, it } from 'vitest'
import type { Memory } from '@shared/memory'
import {
  Bm25Index,
  INDEX_SCHEMA_VERSION,
  buildRetrievalText,
  deriveEntities,
  deriveTitle,
  foldText,
  hashString,
  indexSignature,
  lexTokens,
  lexicalDocOf,
  reciprocalRankFusion,
} from '@shared/memory-retrieval'

const mem = (over: Partial<Memory> & { text: string }): Memory => ({
  id: 'm1',
  kind: 'general',
  tags: [],
  weight: 0.7,
  hits: 0,
  relatedIds: [],
  createdAt: 0,
  ...over,
})

describe('tokens', () => {
  it('ignores case and accent in alphabets that do not need diacritics', () => {
    expect(foldText('Preferência AÉREA')).toBe('preferencia aerea')
  })

  it('preserves diacritics in scripts where they change the word', () => {
    // が != か; removing the dakuten would change the term
    expect(foldText('コーヒーが好き')).toContain('が')
    expect(foldText('コーヒーが好き')).not.toContain('か')
  })

  it('keeps an identifier with a whole number and also when split', () => {
    const tokens = lexTokens('bug no ATL-2291 hoje')
    expect(tokens).toContain('atl-2291')
    expect(tokens).toContain('atl')
    expect(tokens).toContain('2291')
  })

  it('breaks script without spaces into bigrams', () => {
    const tokens = lexTokens('飛行機の座席')
    expect(tokens).toContain('飛行')
    expect(tokens).toContain('行機')
    expect(tokens).toContain('座席')
  })

  it('does not discard words as stopwords: the IDF is what lowers them', () => {
    expect(lexTokens('the flight to Lisbon')).toEqual(expect.arrayContaining(['the', 'flight', 'lisbon']))
  })
})

describe('enriquecimento', () => {
  it('the derived title is the first sentence, without inventing', () => {
    expect(deriveTitle(mem({ text: 'Só viaja com mala de mão. Prefere corredor.' }))).toBe('Só viaja com mala de mão')
  })

  it('the LLM title has priority', () => {
    expect(deriveTitle(mem({ text: 'texto', title: 'Preferências de voo' }))).toBe('Preferências de voo')
  })

  it('heuristic entities come only from what is in the text', () => {
    const found = deriveEntities(mem({ text: 'Em julho fui a Lisboa e usei o cartão ATL-2291.' }))
    expect(found).toContain('ATL-2291')
    for (const entity of found) expect('Em julho fui a Lisboa e usei o cartão ATL-2291.'.includes(entity)).toBe(true)
  })

  it('the index text contains the whole original content', () => {
    const m = mem({
      text: 'Prefere viajar apenas com mala de mão e sentar no corredor.',
      title: 'Preferências de viagem aérea',
      tags: ['viagem'],
      concepts: ['planejamento de voos', 'escolha de assento'],
    })
    const text = buildRetrievalText(m)
    expect(text).toContain(m.text)
    expect(text.toLowerCase()).toContain('preferências de viagem aérea')
    expect(text.toLowerCase()).toContain('escolha de assento')
  })

  it('past the ceiling, it cuts the extras and never the original content', () => {
    const long = 'frase curta. '.repeat(200)
    const text = buildRetrievalText(mem({ text: long, concepts: ['um conceito novo'] }))
    expect(text).toContain('frase curta.')
    expect(text).not.toContain('um conceito novo')
  })

  it('below the ceiling, the extras go in', () => {
    const text = buildRetrievalText(mem({ text: 'Gosta de jazz.', concepts: ['ritmo', 'vinil'] }))
    expect(text).toContain('ritmo')
    expect(text.length).toBeLessThanOrEqual(700)
  })

  it('an extras-only variation does not repeat a term already present', () => {
    const text = buildRetrievalText(mem({ text: 'Gosta de jazz no vinil.', keywords: ['jazz', 'vinil'] }))
    expect(text.toLowerCase().match(/jazz/g)).toHaveLength(1)
  })

  it('the signature changes with content, with enrichment and with model', () => {
    const base = mem({ text: 'Gosta de jazz.', title: 'Música' })
    const model = { id: 'bekko-a8m', dim: 256 }
    const sig = indexSignature(base, model)
    expect(indexSignature({ ...base }, model)).toBe(sig)
    expect(indexSignature({ ...base, text: 'Gosta de samba.' }, model)).not.toBe(sig)
    expect(indexSignature({ ...base, concepts: ['ritmo'] }, model)).not.toBe(sig)
    expect(indexSignature(base, { id: 'bekko-a25m', dim: 256 })).not.toBe(sig)
    expect(indexSignature(base, { id: 'bekko-a8m', dim: 128 })).not.toBe(sig)
    expect(typeof INDEX_SCHEMA_VERSION).toBe('number')
  })

  it('the hash is stable across calls and processes', () => {
    expect(hashString('mala de mão')).toBe(hashString('mala de mão'))
    expect(hashString('a')).not.toBe(hashString('b'))
  })
})

describe('BM25', () => {
  const docs = [
    lexicalDocOf(mem({ id: 'a', text: 'Prefere assento no corredor em voos longos.', tags: ['voo'] })),
    lexicalDocOf(mem({ id: 'b', text: 'Gosta de jazz e compra discos de vinil.', tags: ['música'] })),
    lexicalDocOf(mem({ id: 'c', text: 'O projeto Atlas usa Next.js e Vitest.', tags: ['projeto'] })),
  ]

  it('finds by the exact term', () => {
    expect(new Bm25Index(docs).search('corredor')[0].id).toBe('a')
  })

  it('returns empty when no term appears', () => {
    expect(new Bm25Index(docs).search('fotossíntese')).toEqual([])
  })

  it('a rare identifier weighs more than a word common to the corpus', () => {
    const index = new Bm25Index(docs)
    const [byId] = index.search('Atlas')
    const [byCommon] = index.search('Gosta')
    expect(byId.id).toBe('c')
    expect(byId.score).toBeGreaterThan(byCommon?.score ?? 0)
  })

  it('the IDF mass of the query is the denominator of coverage', () => {
    const index = new Bm25Index(docs)
    expect(index.queryMass('corredor')).toBeGreaterThan(0)
    // an unknown term counts as the rarest of all
    expect(index.queryMass('fotossíntese')).toBeGreaterThan(index.queryMass('corredor'))
    // and a query's mass is the sum of its terms
    expect(index.queryMass('corredor Atlas')).toBeCloseTo(
      index.queryMass('corredor') + index.queryMass('Atlas'),
      10,
    )
  })

  it('is indifferent to document order', () => {
    const forward = new Bm25Index(docs).search('voo corredor')
    const backward = new Bm25Index([...docs].reverse()).search('voo corredor')
    expect(forward[0].id).toBe(backward[0].id)
  })
})

describe('RRF', () => {
  it('combines positions, not scores', () => {
    const fused = reciprocalRankFusion([
      { ids: ['a', 'b', 'c'] },
      { ids: ['c', 'a'] },
    ])
    expect(fused[0].id).toBe('a')
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('an id missing from a list is not discarded', () => {
    const fused = reciprocalRankFusion([{ ids: ['x'] }, { ids: ['y'] }])
    expect(fused.map((f) => f.id).sort()).toEqual(['x', 'y'])
  })

  it('peso desloca o topo', () => {
    const semanticHeavy = reciprocalRankFusion([{ ids: ['a'], weight: 3 }, { ids: ['b'] }])
    const lexHeavy = reciprocalRankFusion([{ ids: ['a'] }, { ids: ['b'], weight: 3 }])
    expect(semanticHeavy[0].id).toBe('a')
    expect(lexHeavy[0].id).toBe('b')
  })

  it('is deterministic on a tie', () => {
    const a = reciprocalRankFusion([{ ids: ['z', 'a'] }])
    const b = reciprocalRankFusion([{ ids: ['z', 'a'] }])
    expect(a).toEqual(b)
  })
})
