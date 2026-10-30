import { describe, expect, it } from 'vitest'

import { numberLines, sourceAnchor } from './document-pages'

/**
 * The citation only counts if the number the model reads is the same one the panel
 * highlights. These tests close the pair: the numbering that goes to the model and the
 * address that comes back on the click.
 */

describe('numberLines', () => {
  it('numbers starting at 1, with the text separated by a bar', () => {
    expect(numberLines('alfa\nbeta')).toBe('  1| alfa\n  2| beta')
  })

  it('preserves an empty line — skipping it would change the count of all the following ones', () => {
    expect(numberLines('a\n\nb')).toBe('  1| a\n  2| \n  3| b')
  })

  it('does not touch the line content', () => {
    const line = '  spaces | pipes | and | accents é'
    expect(numberLines(line)).toBe(`  1| ${line}`)
  })

  it('right-aligns so the text starts in the same column', () => {
    const out = numberLines(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')).split('\n')
    expect(out[0].indexOf('|')).toBe(out[11].indexOf('|'))
  })
})

describe('sourceAnchor', () => {
  it('page address, without a line', () => {
    expect(sourceAnchor('src3', 12)).toBe('#orbit-source/src3/p12')
  })

  it('single line', () => {
    expect(sourceAnchor('doc1', 4, 28)).toBe('#orbit-source/doc1/p4L28')
  })

  it('line range', () => {
    expect(sourceAnchor('doc1', 4, 28, 31)).toBe('#orbit-source/doc1/p4L28-31')
  })

  it('a single-line range does not become a span', () => {
    expect(sourceAnchor('doc1', 4, 28, 28)).toBe('#orbit-source/doc1/p4L28')
  })
})
