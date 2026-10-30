import { describe, expect, it } from 'vitest'

import { createOutputCollector } from './shell'

describe('createOutputCollector', () => {
  it('returns the whole output when it fits', () => {
    const out = createOutputCollector(10, 10)
    out.append('abc')
    out.append('def')
    expect(out.text()).toBe('abcdef')
  })

  it('keeps the beginning and the end, saying how much was cut from the middle', () => {
    // The error of a failing build comes at the end; keeping only the beginning, as
    // before, lost exactly that.
    const out = createOutputCollector(5, 5)
    out.append('HEAD-')
    out.append('x'.repeat(100))
    out.append('-TAIL')
    expect(out.text()).toBe('HEAD-\n… (100 characters omitted from the middle of the output) …\n-TAIL')
  })
})
