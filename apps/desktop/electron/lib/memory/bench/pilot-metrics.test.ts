import { describe, expect, it } from 'vitest'
import { summarize, triage, type LabelEntry, type QueueEntry, type RankRow } from './pilot-metrics'

/**
 * Testes da triagem e dos denominadores do piloto. Nenhum dado real: só ids
 * sintéticos e ranks inventados, para provar *sobre o que* cada métrica é
 * calculada.
 */

const queue = (n: number, role: 'target' | 'no-memory' = 'target'): QueueEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `sc${String(i + 1).padStart(2, '0')}`, memoryId: `mem_${i + 1}`, role }))

const label = (id: string, patch: Partial<LabelEntry> = {}): LabelEntry => ({
  id,
  memoryId: null,
  query: 'uma pergunta qualquer',
  decision: 'inject',
  ...patch,
})

const row = (id: string, patch: Partial<RankRow> = {}): RankRow => ({
  id,
  role: 'target',
  memoryId: `mem_${id}`,
  lexRank: null,
  hybRank: null,
  lexHits: 0,
  hybTopCos: null,
  tier: 'none',
  decision: 'none',
  ...patch,
})

describe('triagem de rótulos', () => {
  it('dez revisados e dez pendentes: os pendentes ficam fora de tudo', () => {
    const q = queue(20)
    const corpus = new Set(q.map((x) => x.memoryId!))
    const labels = q.slice(0, 10).map((x) => label(x.id, { memoryId: x.memoryId }))

    const t = triage(labels, q, corpus)

    expect(t.notInFile).toHaveLength(10)
    expect(t.valid).toHaveLength(10)
    expect(t.decided).toHaveLength(10)
    expect(t.unreviewed).toHaveLength(0)
    expect(t.inconclusive).toHaveLength(0)
    // nenhum pendente virou rótulo "none"
    expect(t.valid.some((l) => q.slice(10).some((p) => p.id === l.id))).toBe(false)
  })

  it('cenário no arquivo sem consulta é "não revisado", não "nenhuma memória"', () => {
    const q = queue(3)
    const corpus = new Set(q.map((x) => x.memoryId!))
    const t = triage([label('sc01', { query: '' }), label('sc02', { query: '   ' }), label('sc03', { query: 'ok' })], q, corpus)

    expect(t.unreviewed).toEqual(['sc01', 'sc02'])
    expect(t.valid.map((l) => l.id)).toEqual(['sc03'])
    expect(t.notInFile).toHaveLength(0)
  })

  it('inconclusivo sai de todos os denominadores', () => {
    const q = queue(2)
    const corpus = new Set(q.map((x) => x.memoryId!))
    const t = triage(
      [label('sc01', { decision: 'inconclusive' }), label('sc02', { memoryId: 'mem_2' })],
      q,
      corpus,
    )

    expect(t.inconclusive).toEqual(['sc01'])
    expect(t.valid.map((l) => l.id)).toEqual(['sc02'])
    expect(t.decided).toHaveLength(1)
  })

  it('decisão ausente entra no ranking e sai da decisão', () => {
    const q = queue(3)
    const corpus = new Set(q.map((x) => x.memoryId!))
    const t = triage(
      [label('sc01', { decision: '' }), label('sc02', { decision: 'talvez' }), label('sc03', { decision: 'pointer' })],
      q,
      corpus,
    )

    expect(t.missingDecision).toEqual(['sc01', 'sc02'])
    expect(t.valid).toHaveLength(3)
    expect(t.decided.map((l) => l.id)).toEqual(['sc03'])
  })

  it('id órfão e alvo inexistente são contados e descartados', () => {
    const q = queue(3)
    const corpus = new Set(q.map((x) => x.memoryId!))
    const t = triage(
      [
        label('sc99', { memoryId: 'mem_1' }), // id que não existe no lote
        label('sc01', { memoryId: 'mem_apagada' }), // alvo fora do acervo
        label('sc02', { memoryId: 'mem_2' }),
      ],
      q,
      corpus,
    )

    expect(t.invalidId).toEqual(['sc99'])
    expect(t.invalidTarget).toEqual(['sc01'])
    expect(t.valid.map((l) => l.id)).toEqual(['sc02'])
  })
})

describe('agregação do piloto', () => {
  it('usa o mesmo conjunto nos dois rankings e particiona top-5 sem sobreposição', () => {
    const rows = [
      row('a', { lexRank: 1, hybRank: 1 }),
      row('b', { lexRank: 4, hybRank: 2 }),
      row('c', { lexRank: null, hybRank: 3 }),
      row('d', { lexRank: 2, hybRank: null }),
      row('e', { lexRank: null, hybRank: null }),
      row('f', { lexRank: 9, hybRank: 7 }),
    ]
    const rep = summarize(rows, 0.433)

    expect(rep.targets.n).toBe(6)
    expect(rep.targets.lexical.n).toBe(6)
    expect(rep.targets.hybrid.n).toBe(6)

    expect(rep.targets.both.sort()).toEqual(['a', 'b'])
    expect(rep.targets.hybOnly).toEqual(['c'])
    expect(rep.targets.lexOnly).toEqual(['d'])
    expect(rep.targets.neither.sort()).toEqual(['e', 'f'])
    // as quatro categorias cobrem exatamente n, sem sobreposição
    const total =
      rep.targets.both.length + rep.targets.hybOnly.length + rep.targets.lexOnly.length + rep.targets.neither.length
    expect(total).toBe(rep.targets.n)

    expect(rep.targets.lexical.r1).toBeCloseTo(1 / 6)
    expect(rep.targets.lexical.r5).toBeCloseTo(3 / 6)
    expect(rep.targets.hybrid.r5).toBeCloseTo(3 / 6)
    // MRR não tem corte em 5: a posição 7 também conta como 1/7
expect(rep.targets.hybrid.mrr).toBeCloseTo((1 + 1 / 2 + 1 / 3 + 1 / 7) / 6)
  })

  it('dez rotulados com alvo produzem métricas sobre dez, e as sem-memória ficam à parte', () => {
    const labeled = [
      ...Array.from({ length: 6 }, (_, i) => row(`t${i}`, { lexRank: 1, hybRank: 1, decision: 'inject', tier: 'inject' })),
      ...Array.from({ length: 4 }, (_, i) => row(`n${i}`, { role: 'no-memory', memoryId: null, lexHits: 1, hybTopCos: 0.2, decision: '' })),
    ]
    const rep = summarize(labeled, 0.433)

    expect(rep.targets.n).toBe(6)
    expect(rep.targets.lexical.r1).toBe(1)
    expect(rep.noMemory.n).toBe(4)
    expect(rep.noMemory.lexReturned).toBe(4)
    expect(rep.noMemory.hybAboveFloor).toBe(0)
    expect(rep.decision).toEqual([{ expected: 'inject', n: 6, match: 6, tiers: { inject: 6 } }])
  })

  it('sem alvo, o ranking não inventa denominador', () => {
    const rep = summarize([row('n1', { role: 'no-memory', memoryId: null })], 0.5)
    expect(rep.targets.n).toBe(0)
    expect(rep.targets.lexical.r1).toBe(0)
    expect(rep.targets.lexical.mrr).toBe(0)
    expect(rep.noMemory.n).toBe(1)
  })
})
