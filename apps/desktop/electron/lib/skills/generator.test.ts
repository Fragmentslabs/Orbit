import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('ai', () => ({ streamText: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))
vi.mock('../reasoning', () => ({ interleavedReasoningField: vi.fn(), normalizeMessages: vi.fn() }))

import { slugify, suggestionFrom } from './generator'

describe('skill suggestionFrom', () => {
  it('keeps what the model wrote and trims it', () => {
    expect(
      suggestionFrom({ name: ' Revisor de PR ', slug: 'revisor_pr', description: ' Use ao revisar. ', content: '  - confira testes ' }),
    ).toEqual({ name: 'Revisor de PR', slug: 'revisor_pr', description: 'Use ao revisar.', content: '- confira testes' })
  })

  it('derives a valid slug from the name when the one given is unusable', () => {
    expect(suggestionFrom({ name: 'Mensagens de commit', slug: '---', content: 'x' })?.slug).toBe('mensagens_de_commit')
    expect(suggestionFrom({ name: 'Ação rápida', slug: 'Ação-Rápida!', content: 'x' })?.slug).toBe('acao_rapida')
  })

  it('refuses an answer without name or content', () => {
    expect(suggestionFrom({ name: 'x' })).toBeNull()
    expect(suggestionFrom({ content: 'x' })).toBeNull()
  })

  it('slugify caps the length and strips accents', () => {
    expect(slugify('é'.repeat(80)).length).toBeLessThanOrEqual(40)
    expect(slugify('Olá Mundo')).toBe('ola_mundo')
  })
})
