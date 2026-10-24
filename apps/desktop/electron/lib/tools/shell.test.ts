import { describe, expect, it } from 'vitest'

import { createOutputCollector } from './shell'

describe('createOutputCollector', () => {
  it('devolve a saída inteira quando cabe', () => {
    const out = createOutputCollector(10, 10)
    out.append('abc')
    out.append('def')
    expect(out.text()).toBe('abcdef')
  })

  it('guarda o começo e o fim, dizendo quanto saiu do meio', () => {
    // O erro de um build que falha vem no fim; guardar só o começo, como
    // antes, perdia exatamente ele.
    const out = createOutputCollector(5, 5)
    out.append('HEAD-')
    out.append('x'.repeat(100))
    out.append('-TAIL')
    expect(out.text()).toBe('HEAD-\n… (100 characters omitted from the middle of the output) …\n-TAIL')
  })
})
