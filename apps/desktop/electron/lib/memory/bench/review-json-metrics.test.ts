import { describe, expect, it } from 'vitest'
import {
  compareMechanisms,
  parseQueries,
  scoreMechanism,
  scoreNoMemory,
  type ReviewQueryJson,
} from './review-json-metrics'

const hit = (rank: number, id: string) => ({ rank, id })

function queries(): ReviewQueryJson[] {
  return [
    {
      id: 'q1',
      expected: 'retrieve',
      lexical: { top5: [hit(1, 'm1'), hit(2, 'm2'), hit(3, 'm3'), hit(4, 'm4'), hit(5, 'm5')] },
      hybrid: { top5: [] },
      memories: {
        m1: { classification: 'relevant' },
        m2: { classification: 'irrelevant' },
        m3: { classification: 'inconclusive' },
        m4: { classification: '' },
        m5: { classification: 'irrelevant' },
      },
    },
    {
      id: 'q2',
      expected: 'retrieve',
      lexical: { top5: [] },
      hybrid: { top5: [hit(1, 'm6'), hit(2, 'm7'), hit(3, 'm10')] },
      memories: {
        m6: { classification: 'irrelevant' },
        m7: { classification: 'relevant' },
        m10: { classification: 'inconclusive' },
      },
    },
    {
      id: 'q3',
      expected: 'none',
      lexical: { top5: [hit(1, 'm8')] },
      hybrid: { top5: [hit(1, 'm9')] },
      memories: {
        m8: { classification: 'irrelevant' },
        m9: { classification: 'relevant' },
      },
    },
  ]
}

describe('metrics of the JSON review', () => {
  it('excludes inconclusive and unjudged from the P@5 denominator', () => {
    const s = scoreMechanism(queries(), 'lexical')
    // q1: judged = m1 (relevant), m2 and m5 (irrelevant) → 3; relevant = 1.
    expect(s.queries).toBe(2)
    expect(s.scored).toBe(1)
    expect(s.p5).toBeCloseTo(1 / 3, 6)
    expect(s.relevant).toBe(1)
    expect(s.irrelevant).toBe(2)
    expect(s.inconclusive).toBe(1)
    expect(s.unjudged).toBe(1)
  })

  it('computes MRR from the position of the first relevant', () => {
    // q1: relevant at position 1 → 1. q2 only exists in the hybrid.
    expect(scoreMechanism(queries(), 'lexical').mrr).toBeCloseTo(1, 6)
    // q2: relevant at position 2 → 1/2.
    expect(scoreMechanism(queries(), 'hybrid').mrr).toBeCloseTo(0.5, 6)
    expect(scoreMechanism(queries(), 'hybrid').p5).toBeCloseTo(1 / 2, 6)
  })

  it('a query with no judgment does not enter the average', () => {
    const s = scoreMechanism(queries(), 'lexical')
    // q2 has nothing judged in the lexical: the basis is q1 alone.
    expect(s.scored).toBe(1)
  })

  it('queries with no memory stay out of P@5 and MRR', () => {
    const s = scoreMechanism(queries(), 'hybrid')
    expect(s.queries).toBe(2) // does not count q3
    expect(s.p5).toBeCloseTo(0.5, 6)
  })

  it('measures the undue candidate in the queries with no memory', () => {
    const lex = scoreNoMemory(queries(), 'lexical')
    expect(lex.queries).toBe(1)
    expect(lex.returned).toBe(1)
    expect(lex.markedRelevant).toBe(0)

    const hyb = scoreNoMemory(queries(), 'hybrid')
    expect(hyb.returned).toBe(1)
    expect(hyb.markedRelevant).toBe(1)
    expect(hyb.conflicts).toEqual(['q3'])
  })

  it('compares the two mechanisms only on the queries with an expected answer', () => {
    const c = compareMechanisms(queries())
    expect(c.lexicalOnly).toEqual(['q1'])
    expect(c.hybridOnly).toEqual(['q2'])
    expect(c.both).toEqual([])
    expect(c.neither).toEqual([])
    expect(c.lexicalOnly.length + c.hybridOnly.length + c.both.length + c.neither.length).toBe(2)
  })

  it('with no judgment at all, it does not divide by zero', () => {
    const empty: ReviewQueryJson[] = [{ id: 'q', expected: 'retrieve', lexical: { top5: [hit(1, 'm')] } }]
    const s = scoreMechanism(empty, 'lexical')
    expect(s.scored).toBe(0)
    expect(s.p5).toBe(0)
    expect(s.mrr).toBe(0)
    expect(s.unjudged).toBe(1)
  })

  it('an unknown classification is treated as unjudged', () => {
    const q: ReviewQueryJson[] = [
      {
        id: 'q',
        expected: 'retrieve',
        lexical: { top5: [hit(1, 'm1')] },
        memories: { m1: { classification: 'maybe' } },
      },
    ]
    const s = scoreMechanism(q, 'lexical')
    expect(s.scored).toBe(0)
    expect(s.unjudged).toBe(1)
  })
})

describe('reading the legacy label file', () => {
  // A file exported before the schema was translated: Portuguese keys and values.
  const legacy = {
    consultas: [
      {
        id: 'q1',
        tipo: 'decisao',
        esperado: 'recuperar',
        lexical: { top5: [{ rank: 1, id: 'm1' }] },
        hibrido: { top5: [{ rank: 1, id: 'm2' }, { rank: 2, id: 'm3', cobertura: 0.4 }] },
        memorias: {
          m1: { texto: 'memória', classificacao: 'irrelevant' },
          m2: { texto: 'outra', classificacao: 'relevant', obs: 'answers it' },
          m3: { texto: 'terceira', classificacao: '' },
        },
      },
      {
        id: 'q2',
        esperado: 'nenhuma',
        lexical: { top5: [{ rank: 1, id: 'm4' }] },
        memorias: { m4: { classificacao: 'relevant' } },
      },
    ],
  }

  it('normalizes the keys and the legacy expectation values', () => {
    const parsed = parseQueries(legacy)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].expected).toBe('retrieve')
    expect(parsed[1].expected).toBe('none')
    expect(parsed[0].type).toBe('decisao')
    expect(parsed[0].hybrid?.top5?.[1].id).toBe('m3')
    expect(parsed[0].hybrid?.top5?.[1].coverage).toBe(0.4)
    expect(parsed[0].memories?.m2).toEqual({ text: 'outra', classification: 'relevant', notes: 'answers it' })
  })

  it('scores a legacy file exactly like the same file in the new format', () => {
    const legacyScores = {
      lexical: scoreMechanism(parseQueries(legacy), 'lexical'),
      hybrid: scoreMechanism(parseQueries(legacy), 'hybrid'),
      noMemory: scoreNoMemory(parseQueries(legacy), 'lexical'),
    }
    const translated = {
      queries: [
        {
          id: 'q1',
          type: 'decisao',
          expected: 'retrieve',
          lexical: { top5: [{ rank: 1, id: 'm1' }] },
          hybrid: { top5: [{ rank: 1, id: 'm2' }, { rank: 2, id: 'm3', coverage: 0.4 }] },
          memories: {
            m1: { text: 'memória', classification: 'irrelevant' },
            m2: { text: 'outra', classification: 'relevant', notes: 'answers it' },
            m3: { text: 'terceira', classification: '' },
          },
        },
        {
          id: 'q2',
          expected: 'none',
          lexical: { top5: [{ rank: 1, id: 'm4' }] },
          memories: { m4: { classification: 'relevant' } },
        },
      ],
    }
    expect(legacyScores.hybrid).toEqual(scoreMechanism(parseQueries(translated), 'hybrid'))
    expect(legacyScores.lexical).toEqual(scoreMechanism(parseQueries(translated), 'lexical'))
    expect(legacyScores.noMemory).toEqual(scoreNoMemory(parseQueries(translated), 'lexical'))
    // And the numbers are the expected ones: q1 hybrid → m2 relevant at 1, m3 unjudged.
    expect(legacyScores.hybrid.mrr).toBeCloseTo(1, 6)
    expect(legacyScores.hybrid.p5).toBeCloseTo(1, 6)
    expect(legacyScores.noMemory.conflicts).toEqual(['q2'])
  })
})
