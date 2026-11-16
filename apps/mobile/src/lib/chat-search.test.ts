import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@orbit/shared'
import { findMatchIds, splitByQuery, stepIndex, reconcileIndex, foldForSearch } from './chat-search'

const msg = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', createdAt: 0, parts: [{ type: 'text', text }], ...extra }) as unknown as ChatMessage

describe('foldForSearch', () => {
  it('lowercases and strips accents', () => {
    expect(foldForSearch('Ação ÇÃO')).toBe('acao cao')
  })
})

describe('findMatchIds', () => {
  const list = [msg('a', 'Hello World'), msg('b', 'nothing'), msg('c', 'ação rápida'), msg('d', 'hello again', { summary: true } as never)]
  it('is case and accent insensitive', () => {
    expect(findMatchIds(list, 'WORLD')).toEqual(['a'])
    expect(findMatchIds(list, 'acao')).toEqual(['c'])
  })
  it('skips summaries and empty queries', () => {
    expect(findMatchIds(list, 'hello')).toEqual(['a'])
    expect(findMatchIds(list, '   ')).toEqual([])
  })
  it('ignores attachment text parts', () => {
    const m = { ...msg('x', ''), parts: [{ type: 'text', text: 'secret pdf', source: 'attachment' }, { type: 'text', text: 'typed' }] } as unknown as ChatMessage
    expect(findMatchIds([m], 'secret')).toEqual([])
    expect(findMatchIds([m], 'typed')).toEqual(['x'])
  })
})

describe('splitByQuery', () => {
  it('marks every occurrence preserving original casing', () => {
    expect(splitByQuery('Foo bar FOO', 'foo')).toEqual([
      { text: 'Foo', match: true },
      { text: ' bar ', match: false },
      { text: 'FOO', match: true },
    ])
  })
  it('matches through accents on the original text', () => {
    expect(splitByQuery('uma Ação', 'acao')).toEqual([
      { text: 'uma ', match: false },
      { text: 'Ação', match: true },
    ])
  })
  it('handles decomposed accents', () => {
    const text = 'café ok'
    const pieces = splitByQuery(text, 'cafe')
    expect(pieces.map((p) => p.text).join('')).toBe(text)
    expect(pieces[0].match).toBe(true)
  })
  it('returns the whole text when nothing matches', () => {
    expect(splitByQuery('abc', 'z')).toEqual([{ text: 'abc', match: false }])
    expect(splitByQuery('abc', '')).toEqual([{ text: 'abc', match: false }])
  })
})

describe('navigation', () => {
  it('wraps both ways', () => {
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
  it('keeps the active message when results change', () => {
    expect(reconcileIndex('b', ['a', 'b', 'c'])).toBe(1)
    expect(reconcileIndex('z', ['a', 'b'])).toBe(0)
    expect(reconcileIndex(undefined, ['a'])).toBe(0)
  })
})
