/**
 * Camada pura da recuperação (packages/shared/memory-retrieval): texto de
 * índice, tokens Unicode, BM25 e RRF. Nada aqui depende de modelo — é a parte
 * que garante o fallback lexical e que o app e o benchmark compartilham.
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
  it('ignora caixa e acento em alfabetos que dispensam diacríticos', () => {
    expect(foldText('Preferência AÉREA')).toBe('preferencia aerea')
  })

  it('preserva diacríticos de escrita em que eles mudam a palavra', () => {
    // が != か; tirar o dakuten mudaria o termo
    expect(foldText('コーヒーが好き')).toContain('が')
    expect(foldText('コーヒーが好き')).not.toContain('か')
  })

  it('mantém identificador com número inteiro e também dividido', () => {
    const tokens = lexTokens('bug no ATL-2291 hoje')
    expect(tokens).toContain('atl-2291')
    expect(tokens).toContain('atl')
    expect(tokens).toContain('2291')
  })

  it('quebra escrita sem espaço em bigramas', () => {
    const tokens = lexTokens('飛行機の座席')
    expect(tokens).toContain('飛行')
    expect(tokens).toContain('行機')
    expect(tokens).toContain('座席')
  })

  it('não descarta palavras por stopword: quem rebaixa é o IDF', () => {
    expect(lexTokens('the flight to Lisbon')).toEqual(expect.arrayContaining(['the', 'flight', 'lisbon']))
  })
})

describe('enriquecimento', () => {
  it('título derivado é a primeira oração, sem inventar', () => {
    expect(deriveTitle(mem({ text: 'Só viaja com mala de mão. Prefere corredor.' }))).toBe('Só viaja com mala de mão')
  })

  it('título do LLM tem prioridade', () => {
    expect(deriveTitle(mem({ text: 'texto', title: 'Preferências de voo' }))).toBe('Preferências de voo')
  })

  it('entidades heurísticas saem só do que está no texto', () => {
    const found = deriveEntities(mem({ text: 'Em julho fui a Lisboa e usei o cartão ATL-2291.' }))
    expect(found).toContain('ATL-2291')
    for (const entity of found) expect('Em julho fui a Lisboa e usei o cartão ATL-2291.'.includes(entity)).toBe(true)
  })

  it('o texto de índice contém o conteúdo original inteiro', () => {
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

  it('passando do teto, corta os extras e nunca o conteúdo original', () => {
    const long = 'frase curta. '.repeat(200)
    const text = buildRetrievalText(mem({ text: long, concepts: ['um conceito novo'] }))
    expect(text).toContain('frase curta.')
    expect(text).not.toContain('um conceito novo')
  })

  it('abaixo do teto, os extras entram', () => {
    const text = buildRetrievalText(mem({ text: 'Gosta de jazz.', concepts: ['ritmo', 'vinil'] }))
    expect(text).toContain('ritmo')
    expect(text.length).toBeLessThanOrEqual(700)
  })

  it('variação só de extras não repete termo já presente', () => {
    const text = buildRetrievalText(mem({ text: 'Gosta de jazz no vinil.', keywords: ['jazz', 'vinil'] }))
    expect(text.toLowerCase().match(/jazz/g)).toHaveLength(1)
  })

  it('a assinatura muda com conteúdo, com enriquecimento e com modelo', () => {
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

  it('hash é estável entre chamadas e processos', () => {
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

  it('acha pelo termo exato', () => {
    expect(new Bm25Index(docs).search('corredor')[0].id).toBe('a')
  })

  it('devolve vazio quando nenhum termo aparece', () => {
    expect(new Bm25Index(docs).search('fotossíntese')).toEqual([])
  })

  it('identificador raro pesa mais que palavra comum ao acervo', () => {
    const index = new Bm25Index(docs)
    const [byId] = index.search('Atlas')
    const [byCommon] = index.search('Gosta')
    expect(byId.id).toBe('c')
    expect(byId.score).toBeGreaterThan(byCommon?.score ?? 0)
  })

  it('a massa de IDF da consulta é o denominador da cobertura', () => {
    const index = new Bm25Index(docs)
    expect(index.queryMass('corredor')).toBeGreaterThan(0)
    // termo desconhecido conta como o mais raro de todos
    expect(index.queryMass('fotossíntese')).toBeGreaterThan(index.queryMass('corredor'))
    // e a massa de uma consulta é a soma dos termos dela
    expect(index.queryMass('corredor Atlas')).toBeCloseTo(
      index.queryMass('corredor') + index.queryMass('Atlas'),
      10,
    )
  })

  it('é indiferente à ordem dos documentos', () => {
    const forward = new Bm25Index(docs).search('voo corredor')
    const backward = new Bm25Index([...docs].reverse()).search('voo corredor')
    expect(forward[0].id).toBe(backward[0].id)
  })
})

describe('RRF', () => {
  it('combina posições, não scores', () => {
    const fused = reciprocalRankFusion([
      { ids: ['a', 'b', 'c'] },
      { ids: ['c', 'a'] },
    ])
    expect(fused[0].id).toBe('a')
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('id ausente de uma lista não é descartado', () => {
    const fused = reciprocalRankFusion([{ ids: ['x'] }, { ids: ['y'] }])
    expect(fused.map((f) => f.id).sort()).toEqual(['x', 'y'])
  })

  it('peso desloca o topo', () => {
    const semHeavy = reciprocalRankFusion([{ ids: ['a'], weight: 3 }, { ids: ['b'] }])
    const lexHeavy = reciprocalRankFusion([{ ids: ['a'] }, { ids: ['b'], weight: 3 }])
    expect(semHeavy[0].id).toBe('a')
    expect(lexHeavy[0].id).toBe('b')
  })

  it('é determinístico no empate', () => {
    const a = reciprocalRankFusion([{ ids: ['z', 'a'] }])
    const b = reciprocalRankFusion([{ ids: ['z', 'a'] }])
    expect(a).toEqual(b)
  })
})
