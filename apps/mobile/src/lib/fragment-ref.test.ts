import { describe, expect, it } from 'vitest'
import { fragmentIdOfPart } from './fragment-ref'

describe('fragmentIdOfPart', () => {
  it('reads the id fragment_create answered with, serialized or not', () => {
    expect(fragmentIdOfPart({ output: '{"fragmentId":"frag-gastos-a1b2c3","message":"Fragment \\"Gastos\\" created"}' })).toBe('frag-gastos-a1b2c3')
    expect(fragmentIdOfPart({ output: 'fragmentId: frag-timer-0f9e8d' })).toBe('frag-timer-0f9e8d')
  })

  it('reads the id the other tools take as input, and nothing from a part that has none', () => {
    expect(fragmentIdOfPart({ input: { fragmentId: 'frag-x-123abc', path: 'index.html' } })).toBe('frag-x-123abc')
    expect(fragmentIdOfPart({ input: { fragmentId: 'nope' }, output: 'done' })).toBeNull()
    expect(fragmentIdOfPart({})).toBeNull()
  })
})
