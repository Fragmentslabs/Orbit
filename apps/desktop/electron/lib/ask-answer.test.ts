import { describe, expect, it } from 'vitest'
import { formatAskAnswer, formatAskLine } from '@shared/chat'

describe('question answer', () => {
  it('option and free text go separately, with the text labeled', () => {
    expect(formatAskAnswer(['PostgreSQL'], ' with pgvector ', 'Note')).toBe(
      'PostgreSQL\nNote: with pgvector',
    )
  })

  it('several options are not confused with the text (which may have a comma)', () => {
    expect(formatAskAnswer(['A', 'B'], 'no tests, for now', 'Note')).toBe(
      'A, B\nNote: no tests, for now',
    )
  })

  it('with no option marked the text is the answer, without a label', () => {
    expect(formatAskAnswer([], 'something else', 'Note')).toBe('something else')
  })

  it('only an option, or nothing', () => {
    expect(formatAskAnswer(['A'], '  ', 'Note')).toBe('A')
    expect(formatAskAnswer([], undefined, 'Note')).toBe('')
  })

  it('the line for the agent aligns the note under the arrow', () => {
    expect(formatAskLine(0, 'Which database?', 'PostgreSQL\nNote: with pgvector')).toBe(
      '1. Which database?\n   → PostgreSQL\n     Note: with pgvector',
    )
  })
})
