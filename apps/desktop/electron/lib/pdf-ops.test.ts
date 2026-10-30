import { describe, expect, it } from 'vitest'

import { parsePageRange } from './pdf-ops'

/**
 * The page range is where the model most often errs and where the error is silent:
 * a badly read range produces a PDF with the wrong pages, which looks
 * perfectly valid.
 */
describe('parsePageRange', () => {
  it('reads loose pages and ranges', () => {
    expect(parsePageRange('1,3,5', 10)).toEqual([1, 3, 5])
    expect(parsePageRange('2-5', 10)).toEqual([2, 3, 4, 5])
    expect(parsePageRange('1-3,7', 10)).toEqual([1, 2, 3, 7])
  })

  it('preserves the requested ORDER — that is what allows reordering, not just filtering', () => {
    expect(parsePageRange('5,1,3', 10)).toEqual([5, 1, 3])
  })

  it('an inverted range counts backwards', () => {
    // "9-7" is an intention of reverse order; returning empty would obey the
    // syntax and ignore the request.
    expect(parsePageRange('9-7', 10)).toEqual([9, 8, 7])
  })

  it('discards pages outside the document instead of failing', () => {
    expect(parsePageRange('1,99,3', 5)).toEqual([1, 3])
    expect(parsePageRange('0,1', 5)).toEqual([1])
  })

  it('tolerates spaces and empty entries', () => {
    expect(parsePageRange(' 1 - 2 , , 4 ', 10)).toEqual([1, 2, 4])
  })

  it('a range with nothing valid returns an empty list — the caller warns the user', () => {
    expect(parsePageRange('abc', 10)).toEqual([])
    expect(parsePageRange('', 10)).toEqual([])
  })

  it('repeating a page is allowed (duplicating a sheet is a legitimate request)', () => {
    expect(parsePageRange('1,1,2', 5)).toEqual([1, 1, 2])
  })
})
