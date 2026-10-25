/**
 * Consulta de recuperação a partir da conversa recente (Fase 4).
 */
import { describe, expect, it } from 'vitest'
import { contextualQuery, isShortMessage, isolatedQuery, needsContextRetry, type ChatTurn } from '@shared/memory-query'

const turns: ChatTurn[] = [
  { role: 'user', text: 'Estou pensando em comprar uma passagem para o Rio na sexta.' },
  { role: 'assistant', text: 'Posso procurar voos de sexta. Quer saída de manhã ou à tarde? Consigo filtrar por companhia também.' },
]

describe('mensagem isolada', () => {
  it('semântico e lexical são o mesmo texto', () => {
    const q = isolatedQuery('  Qual meu assento preferido?  ')
    expect(q.semantic).toBe('Qual meu assento preferido?')
    expect(q.lexical).toBe(q.semantic)
    expect(q.usedContext).toBe(false)
  })
})

describe('mensagem + contexto', () => {
  it('o texto semântico junta o contexto e a mensagem', () => {
    const q = contextualQuery('Quero o mais barato.', turns)
    expect(q.usedContext).toBe(true)
    expect(q.semantic).toContain('passagem para o Rio')
    expect(q.semantic).toContain('Quero o mais barato.')
    expect(q.semantic.indexOf('passagem')).toBeLessThan(q.semantic.indexOf('Quero o mais barato.'))
  })

  it('a busca lexical continua sendo só a mensagem original', () => {
    const q = contextualQuery('Quero o mais barato.', turns)
    expect(q.lexical).toBe('Quero o mais barato.')
  })

  it('sem contexto, cai na consulta isolada', () => {
    expect(contextualQuery('E quanto custaria?', [])).toEqual(isolatedQuery('E quanto custaria?'))
  })

  it('respeita o orçamento de caracteres', () => {
    const long: ChatTurn[] = [
      { role: 'user', text: 'palavra '.repeat(200) },
      { role: 'assistant', text: 'resposta '.repeat(200) },
    ]
    const q = contextualQuery('E isso?', long, { maxContextChars: 120 })
    expect(q.semantic.length).toBeLessThanOrEqual(120 + 'E isso?'.length + 2)
  })

  it('não repete a conversa inteira: só o turno mais recente de cada papel', () => {
    const many: ChatTurn[] = [
      { role: 'user', text: 'assunto antigo sobre jardim' },
      { role: 'assistant', text: 'resposta antiga sobre jardim' },
      ...turns,
    ]
    const q = contextualQuery('E o preço?', many)
    expect(q.semantic).toContain('passagem para o Rio')
    expect(q.semantic).not.toContain('jardim')
  })
})

describe('quando vale refazer com contexto', () => {
  it('mensagem curta, com contexto e sem evidência: refaz', () => {
    expect(needsContextRetry('E quanto custaria?', true, false)).toBe(true)
  })

  it('achou evidência na primeira busca: não refaz', () => {
    expect(needsContextRetry('E quanto custaria?', true, true)).toBe(false)
  })

  it('sem contexto anterior: não refaz', () => {
    expect(needsContextRetry('E quanto custaria?', false, false)).toBe(false)
  })

  it('mensagem longa se explica sozinha: não refaz', () => {
    expect(needsContextRetry('Quanto custa uma passagem de São Paulo para Lisboa em março?', true, false)).toBe(false)
  })

  it('a régua de "curta" é por tokens, não por caracteres', () => {
    expect(isShortMessage('E o código da academia?')).toBe(true)
    expect(isShortMessage('Preciso decidir entre o Dell XPS e o MacBook Air para o trabalho')).toBe(false)
  })
})
