import { describe, expect, it } from 'vitest'

import { locateText, selectionScaleX, type PdfTextItem } from './pdf-text'

/**
 * The highlight in the PDF comes out of here. The risk of the layer is FRAGMENTATION: the PDF
 * breaks the sentence into several items and the position of the spaces between them is not
 * reliable, so the sentence one reads on the page almost never exists as a contiguous string
 * in the items. A naive search finds nothing — and the panel would show the
 * right page without any mark, which is indistinguishable from "it is not here".
 */

/** Items on one line, each with its slice of the width. */
function line(pieces: string[], y = 0.5): PdfTextItem[] {
  let x = 0.1
  return pieces.map((text) => {
    const width = text.length * 0.01
    const item = { x, y, width, height: 0.02, text }
    x += width
    return item
  })
}

describe('locateText', () => {
  it('finds the excerpt contained in a single item', () => {
    const rects = locateText(line(['O prazo e de noventa dias']), 'noventa dias')
    expect(rects).toHaveLength(1)
  })

  it('finds the excerpt BROKEN across items — the case the naive search misses', () => {
    const rects = locateText(line(['O prazo e de nov', 'enta', ' dias']), 'noventa dias')
    expect(rects).toHaveLength(3)
  })

  it('ignores the spacing difference between items', () => {
    const rects = locateText(line(['um', '  destino', 'unico']), 'um destino unico')
    expect(rects).toHaveLength(3)
  })

  it('does not tell upper case from lower case', () => {
    expect(locateText(line(['Unicast envia']), 'unicast')).toHaveLength(1)
  })

  it('returns ALL occurrences, not only the first', () => {
    const items = [...line(['unicast aqui'], 0.2), ...line(['e unicast ali'], 0.4)]
    const rects = locateText(items, 'unicast')
    expect(rects).toHaveLength(2)
    // On different lines: that is what proves it did not mark the same one twice.
    expect(new Set(rects.map((r) => r.y)).size).toBe(2)
  })

  it('the occurrences do not overlap — it advances past the match', () => {
    const rects = locateText(line(['aaaa']), 'aa')
    expect(rects).toHaveLength(2)
  })

  it('a missing excerpt marks nothing', () => {
    expect(locateText(line(['texto qualquer']), 'inexistente')).toEqual([])
  })

  it('too short a search marks nothing — it would mark the whole page', () => {
    expect(locateText(line(['a b c']), 'a')).toEqual([])
    expect(locateText(line(['a b c']), ' ')).toEqual([])
  })

  it('a page with no text returns empty instead of failing', () => {
    expect(locateText([], 'qualquer')).toEqual([])
  })

  it("returns the rectangle of the item, as a fraction of the page", () => {
    const [rect] = locateText([{ x: 0.1, y: 0.2, width: 0.3, height: 0.02, text: 'alvo' }], 'alvo')
    expect(rect).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.02 })
  })

  it('respects the occurrence cap', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      x: 0.1,
      y: i * 0.01,
      width: 0.05,
      height: 0.02,
      text: 'alvo',
    }))
    expect(locateText(items, 'alvo', 10)).toHaveLength(10)
  })
})

describe('selectionScaleX', () => {
  const item = (text: string, width: number): PdfTextItem => ({
    x: 0,
    y: 0,
    width,
    height: 0.02,
    text,
  })

  it('text wider than estimated stretches the layer', () => {
    // 10 characters, height 0.02, page 1:1 → estimate 0.1 of width.
    expect(selectionScaleX(item('0123456789', 0.2), 1)).toBeCloseTo(2, 5)
  })

  it('narrower text shrinks', () => {
    expect(selectionScaleX(item('0123456789', 0.05), 1)).toBeCloseTo(0.5, 5)
  })

  it('the page ratio goes into the count', () => {
    // Width and height are fractions of different axes: on a page wider
    // than tall, the same width fraction covers more pixels.
    const square = selectionScaleX(item('0123456789', 0.1), 1)
    const wide = selectionScaleX(item('0123456789', 0.1), 2)
    expect(wide).toBeCloseTo(square * 2, 5)
  })

  it('stays in a sane range even with a degenerate item', () => {
    expect(selectionScaleX(item('', 0.5), 1)).toBe(1)
    expect(selectionScaleX({ x: 0, y: 0, width: 0.5, height: 0, text: 'x' }, 1)).toBe(1)
    expect(selectionScaleX(item('x', 9), 1)).toBeLessThanOrEqual(3)
    expect(selectionScaleX(item('x'.repeat(500), 0.001), 1)).toBeGreaterThanOrEqual(0.2)
  })
})
