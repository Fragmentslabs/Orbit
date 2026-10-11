import { describe, expect, it } from 'vitest'
import { formatAskAnswer, formatAskLine } from '@shared/chat'

describe('resposta de pergunta', () => {
  it('opção e texto livre vão separados, com o texto rotulado', () => {
    expect(formatAskAnswer(['PostgreSQL'], ' com pgvector ', 'Observação')).toBe(
      'PostgreSQL\nObservação: com pgvector',
    )
  })

  it('várias opções não se confundem com o texto (que pode ter vírgula)', () => {
    expect(formatAskAnswer(['A', 'B'], 'sem testes, por enquanto', 'Note')).toBe(
      'A, B\nNote: sem testes, por enquanto',
    )
  })

  it('sem opção marcada o texto é a resposta, sem rótulo', () => {
    expect(formatAskAnswer([], 'outra coisa', 'Observação')).toBe('outra coisa')
  })

  it('só opção, ou nada', () => {
    expect(formatAskAnswer(['A'], '  ', 'Observação')).toBe('A')
    expect(formatAskAnswer([], undefined, 'Observação')).toBe('')
  })

  it('a linha para o agente alinha a observação sob a seta', () => {
    expect(formatAskLine(0, 'Qual banco?', 'PostgreSQL\nObservação: com pgvector')).toBe(
      '1. Qual banco?\n   → PostgreSQL\n     Observação: com pgvector',
    )
  })
})
