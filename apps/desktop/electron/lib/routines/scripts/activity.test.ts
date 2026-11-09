import { describe, expect, it } from 'vitest'
import { applyCheck, emptyActivity, isDue, isFailing, nextCheckAfter } from './activity'

const MIN = 60_000

describe('nextCheckAfter', () => {
  it('waits the interval when all is well', () => {
    expect(nextCheckAfter(0, 2, 0)).toBe(2 * MIN)
  })
  it('doubles per failure, never beyond an hour and never below the interval', () => {
    expect(nextCheckAfter(0, 2, 1)).toBe(4 * MIN)
    expect(nextCheckAfter(0, 2, 2)).toBe(8 * MIN)
    expect(nextCheckAfter(0, 2, 10)).toBe(60 * MIN)
    expect(nextCheckAfter(0, 120, 1)).toBe(120 * MIN)
  })
})

describe('applyCheck', () => {
  it('records fires and queues them', () => {
    const { activity, accepted } = applyCheck(emptyActivity('r'), { ok: true, fires: ['{"a":1}'], logs: [] }, 1000, 2)
    expect(accepted).toEqual(['{"a":1}'])
    expect(activity.pending).toEqual(['{"a":1}'])
    expect(activity.lastFireAt).toBe(1000)
    expect(activity.checks[0]).toMatchObject({ ok: true, fired: 1 })
  })

  it('drops fires that come too soon after the last one', () => {
    const first = applyCheck(emptyActivity('r'), { ok: true, fires: ['a'], logs: [] }, 1000, 2).activity
    const second = applyCheck(first, { ok: true, fires: ['b'], logs: [] }, 1000 + MIN, 2)
    expect(second.accepted).toEqual([])
    expect(second.activity.checks[1].error).toMatch(/too soon/)
    const later = applyCheck(second.activity, { ok: true, fires: ['c'], logs: [] }, 1000 + 6 * MIN, 2)
    expect(later.accepted).toEqual(['c'])
  })

  it('counts failures, backs off, and a success clears them', () => {
    let a = emptyActivity('r')
    for (let i = 0; i < 3; i++) a = applyCheck(a, { ok: false, error: 'x', logs: [] }, i, 2).activity
    expect(a.failures).toBe(3)
    expect(isFailing(a)).toBe(true)
    expect(isDue(a, 0)).toBe(false)
    a = applyCheck(a, { ok: true, fires: [], logs: [] }, 100 * MIN, 2).activity
    expect(a.failures).toBe(0)
    expect(isFailing(a)).toBe(false)
  })
})
