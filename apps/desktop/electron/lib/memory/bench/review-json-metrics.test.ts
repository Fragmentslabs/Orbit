import { describe, expect, it } from 'vitest'
import {
  compareMechanisms,
  scoreMechanism,
  scoreNoMemory,
  type ReviewQueryJson,
} from './review-json-metrics'

const hit = (rank: number, id: string) => ({ rank, id })

function queries(): ReviewQueryJson[] {
  return [
    {
      id: 'q1',
      esperado: 'recuperar',
      lexical: { top5: [hit(1, 'm1'), hit(2, 'm2'), hit(3, 'm3'), hit(4, 'm4'), hit(5, 'm5')] },
      hibrido: { top5: [] },
      memorias: {
        m1: { classificacao: 'relevant' },
        m2: { classificacao: 'irrelevant' },
        m3: { classificacao: 'inconclusive' },
        m4: { classificacao: '' },
        m5: { classificacao: 'irrelevant' },
      },
    },
    {
      id: 'q2',
      esperado: 'recuperar',
      lexical: { top5: [] },
      hibrido: { top5: [hit(1, 'm6'), hit(2, 'm7'), hit(3, 'm10')] },
      memorias: {
        m6: { classificacao: 'irrelevant' },
        m7: { classificacao: 'relevant' },
        m10: { classificacao: 'inconclusive' },
      },
    },
    {
      id: 'q3',
      esperado: 'nenhuma',
      lexical: { top5: [hit(1, 'm8')] },
      hibrido: { top5: [hit(1, 'm9')] },
      memorias: {
        m8: { classificacao: 'irrelevant' },
        m9: { classificacao: 'relevant' },
      },
    },
  ]
}

describe('métricas da avaliação por JSON', () => {
  it('exclui inconclusivo e não julgado do denominador de P@5', () => {
    const s = scoreMechanism(queries(), 'lexical')
    // q1: julgados = m1 (relevant), m2 e m5 (irrelevant) → 3; relevantes = 1.
    expect(s.consultas).toBe(2)
    expect(s.avaliadas).toBe(1)
    expect(s.p5).toBeCloseTo(1 / 3, 6)
    expect(s.relevantes).toBe(1)
    expect(s.irrelevantes).toBe(2)
    expect(s.inconclusivos).toBe(1)
    expect(s.semJulgamento).toBe(1)
  })

  it('calcula MRR pela posição do primeiro relevant', () => {
    // q1: relevant na posição 1 → 1. q2 só existe no híbrido.
    expect(scoreMechanism(queries(), 'lexical').mrr).toBeCloseTo(1, 6)
    // q2: relevant na posição 2 → 1/2.
    expect(scoreMechanism(queries(), 'hibrido').mrr).toBeCloseTo(0.5, 6)
    expect(scoreMechanism(queries(), 'hibrido').p5).toBeCloseTo(1 / 2, 6)
  })

  it('consulta sem julgamento não entra na média', () => {
    const s = scoreMechanism(queries(), 'lexical')
    // q2 não tem nada julgado no lexical: base é só q1.
    expect(s.avaliadas).toBe(1)
  })

  it('consultas sem memória ficam fora de P@5 e MRR', () => {
    const s = scoreMechanism(queries(), 'hibrido')
    expect(s.consultas).toBe(2) // não conta q3
    expect(s.p5).toBeCloseTo(0.5, 6)
  })

  it('mede candidato indevido nas consultas sem memória', () => {
    const lex = scoreNoMemory(queries(), 'lexical')
    expect(lex.consultas).toBe(1)
    expect(lex.retornou).toBe(1)
    expect(lex.marcouRelevante).toBe(0)

    const hyb = scoreNoMemory(queries(), 'hibrido')
    expect(hyb.retornou).toBe(1)
    expect(hyb.marcouRelevante).toBe(1)
    expect(hyb.conflitos).toEqual(['q3'])
  })

  it('compara os dois mecanismos só nas consultas com resposta esperada', () => {
    const c = compareMechanisms(queries())
    expect(c.soLexical).toEqual(['q1'])
    expect(c.soHibrido).toEqual(['q2'])
    expect(c.ambos).toEqual([])
    expect(c.nenhum).toEqual([])
    expect(c.soLexical.length + c.soHibrido.length + c.ambos.length + c.nenhum.length).toBe(2)
  })

  it('sem julgamento nenhum, não divide por zero', () => {
    const vazio: ReviewQueryJson[] = [{ id: 'q', esperado: 'recuperar', lexical: { top5: [hit(1, 'm')] } }]
    const s = scoreMechanism(vazio, 'lexical')
    expect(s.avaliadas).toBe(0)
    expect(s.p5).toBe(0)
    expect(s.mrr).toBe(0)
    expect(s.semJulgamento).toBe(1)
  })

  it('classificação desconhecida é tratada como não julgada', () => {
    const q: ReviewQueryJson[] = [
      {
        id: 'q',
        esperado: 'recuperar',
        lexical: { top5: [hit(1, 'm1')] },
        memorias: { m1: { classificacao: 'talvez' } },
      },
    ]
    const s = scoreMechanism(q, 'lexical')
    expect(s.avaliadas).toBe(0)
    expect(s.semJulgamento).toBe(1)
  })
})
