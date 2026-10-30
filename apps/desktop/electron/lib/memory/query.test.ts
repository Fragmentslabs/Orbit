/**
 * Retrieval query built from the recent conversation (Phase 4).
 */
import { describe, expect, it } from 'vitest'
import { contextualQuery, isShortMessage, isolatedQuery, needsContextRetry, type ChatTurn } from '@shared/memory-query'

const turns: ChatTurn[] = [
  { role: 'user', text: 'Estou pensando em comprar uma passagem para o Rio na sexta.' },
  { role: 'assistant', text: 'Posso procurar voos de sexta. Quer saída de manhã ou à tarde? Consigo filtrar por companhia também.' },
]

describe('isolated message', () => {
  it('semantic and lexical are the same text', () => {
    const q = isolatedQuery('  Qual meu assento preferido?  ')
    expect(q.semantic).toBe('Qual meu assento preferido?')
    expect(q.lexical).toBe(q.semantic)
    expect(q.usedContext).toBe(false)
  })
})

describe('message + context', () => {
  it('the semantic text joins the context and the message', () => {
    const q = contextualQuery('Quero o mais barato.', turns)
    expect(q.usedContext).toBe(true)
    expect(q.semantic).toContain('passagem para o Rio')
    expect(q.semantic).toContain('Quero o mais barato.')
    expect(q.semantic.indexOf('passagem')).toBeLessThan(q.semantic.indexOf('Quero o mais barato.'))
  })

  it('the lexical search is still only the original message', () => {
    const q = contextualQuery('Quero o mais barato.', turns)
    expect(q.lexical).toBe('Quero o mais barato.')
  })

  it('with no context, it falls back to the isolated query', () => {
    expect(contextualQuery('E quanto custaria?', [])).toEqual(isolatedQuery('E quanto custaria?'))
  })

  it('respects the character budget', () => {
    const long: ChatTurn[] = [
      { role: 'user', text: 'palavra '.repeat(200) },
      { role: 'assistant', text: 'resposta '.repeat(200) },
    ]
    const q = contextualQuery('E isso?', long, { maxContextChars: 120 })
    expect(q.semantic.length).toBeLessThanOrEqual(120 + 'E isso?'.length + 2)
  })

  it('does not repeat the whole conversation: only the most recent turn of each role', () => {
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

describe('when it is worth redoing with context', () => {
  it('short message, with context and no evidence: redoes it', () => {
    expect(needsContextRetry('E quanto custaria?', true, false)).toBe(true)
  })

  it('found evidence in the first search: does not redo it', () => {
    expect(needsContextRetry('E quanto custaria?', true, true)).toBe(false)
  })

  it('with no previous context: does not redo', () => {
    expect(needsContextRetry('E quanto custaria?', false, false)).toBe(false)
  })

  it('a long message explains itself: does not redo', () => {
    expect(needsContextRetry('Quanto custa uma passagem de São Paulo para Lisboa em março?', true, false)).toBe(false)
  })

  it('the "short" ruler is by tokens, not by characters', () => {
    expect(isShortMessage('E o código da academia?')).toBe(true)
    expect(isShortMessage('Preciso decidir entre o Dell XPS e o MacBook Air para o trabalho')).toBe(false)
  })
})
