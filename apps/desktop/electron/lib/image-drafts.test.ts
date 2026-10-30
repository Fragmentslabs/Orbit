import { describe, expect, it } from 'vitest'
import { selectDraftImages } from './image-drafts'

/**
 * What is at stake: on one side, the user's gallery becoming the agent's
 * draft; on the other, deleting an image it wanted. Both real cases
 * are here — the ladder, which the first version already caught, and the fan, which it
 * let pass whole.
 */

const chain = (pares: [string, string][]) => new Map(pares)

describe('selectDraftImages', () => {
  it('discards the step of the ladder and keeps the top', () => {
    const drafts = selectDraftImages({
      produced: ['b', 'c', 'd'],
      parents: chain([
        ['b', 'attachment'],
        ['c', 'b'],
        ['d', 'c'],
      ]),
      keep: new Set(),
    })
    expect(drafts.sort()).toEqual(['b', 'c'])
  })

  it('discards the earlier attempts made from the same base', () => {
    // "that takes the green out better": four crops of the SAME original, with different
    // tolerances. None is the parent of another — it was the case that passed whole.
    const drafts = selectDraftImages({
      produced: ['t1', 't2', 't3', 't4'],
      parents: chain([
        ['t1', 'attachment'],
        ['t2', 'attachment'],
        ['t3', 'attachment'],
        ['t4', 'attachment'],
      ]),
      keep: new Set(),
    })
    expect(drafts.sort()).toEqual(['t1', 't2', 't3'])
  })

  it('never discards what the agent marked as a delivery', () => {
    // Variants for the user to choose from: same base, all survive.
    const drafts = selectDraftImages({
      produced: ['v1', 'v2', 'v3'],
      parents: chain([
        ['v1', 'attachment'],
        ['v2', 'attachment'],
        ['v3', 'attachment'],
      ]),
      keep: new Set(['v1', 'v2', 'v3']),
    })
    expect(drafts).toEqual([])
  })

  it('does not touch the user attachment nor the base of a previous turn', () => {
    // 'attachment' is the parent of everything and is not in produced: it is not from this answer.
    const drafts = selectDraftImages({
      produced: ['b'],
      parents: chain([['b', 'attachment']]),
      keep: new Set(),
    })
    expect(drafts).toEqual([])
  })

  it('mixes the two formats: redid it twice and then kept editing', () => {
    // t1 and t2 come out of the attachment (t1 is a discarded attempt); out of t2 comes the text,
    // which in turn becomes the compressed version. Only the last one is left.
    const drafts = selectDraftImages({
      produced: ['t1', 't2', 'text', 'final'],
      parents: chain([
        ['t1', 'attachment'],
        ['t2', 'attachment'],
        ['text', 't2'],
        ['final', 'text'],
      ]),
      keep: new Set(),
    })
    expect(drafts.sort()).toEqual(['t1', 't2', 'text'])
  })
})
