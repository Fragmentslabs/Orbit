import { describe, expect, it } from 'vitest'
import { nextRun, upcomingRuns } from '@shared/routines'
import type { Routine, Schedule } from '@shared/routines'

/**
 * Tests of the next-run computation — the heart of the scheduler. Times chosen
 * far from midnight so they hold in any local timezone.
 */

// hh is already "HH:MM" — this only appends the seconds.
const DAY = (d: string, hh: string) => new Date(`${d}T${hh}:00`).getTime()

describe('nextRun — classic schedules', () => {
  it('daily: next time today when it has not passed yet', () => {
    const target = nextRun({ time: '09:00' }, DAY('2026-10-29', '08:00'))
    expect(target).toBe(DAY('2026-10-29', '09:00'))
  })

  it('daily: moves to tomorrow when the time has already passed', () => {
    const target = nextRun({ time: '09:00' }, DAY('2026-10-29', '10:00'))
    expect(target).toBe(DAY('2026-10-30', '09:00'))
  })

  it('weekly: respects the marked days, skipping the whole week', () => {
    // 2026-10-29 is a Friday (5); with Monday only (1), the next one is 11-02
    const target = nextRun({ time: '12:00', days: [1] }, DAY('2026-10-29', '08:00'))
    expect(target).toBe(DAY('2026-11-02', '12:00'))
  })

  it('interval in days: counts from the last execution', () => {
    const last = DAY('2026-10-26', '12:00')
    const target = nextRun({ time: '12:00', intervalDays: 3 }, DAY('2026-10-29', '08:00'), last)
    expect(target).toBe(DAY('2026-10-29', '12:00'))
  })

  it('invalid time: null instead of guessing', () => {
    expect(nextRun({ time: '09:0' }, DAY('2026-10-29', '08:00'))).toBeNull()
  })
})

describe('nextRun — every N hours', () => {
  it('with no previous run: the first one lands on the time of day', () => {
    const target = nextRun({ time: '09:00', intervalHours: 4 }, DAY('2026-10-29', '07:00'))
    expect(target).toBe(DAY('2026-10-29', '09:00'))
  })

  it('with a previous run: adds N hours from it', () => {
    const last = DAY('2026-10-29', '06:00')
    const target = nextRun({ time: '09:00', intervalHours: 4 }, DAY('2026-10-29', '07:00'), last)
    expect(target).toBe(DAY('2026-10-29', '10:00'))
  })

  it('long missed window: O(1) jump, no hour loop', () => {
    const last = DAY('2026-10-01', '09:00')
    const target = nextRun({ time: '09:00', intervalHours: 6 }, DAY('2026-10-20', '08:00'), last)
    expect(target).toBeGreaterThan(DAY('2026-10-20', '08:00'))
    // Exact multiple of the interval counted from the last execution
    const jumps = (target! - last) / (6 * 3600_000)
    expect(jumps % 1).toBe(0)
  })
})

describe('nextRun — once', () => {
  it('future date: returns the single firing', () => {
    const target = nextRun({ time: '08:30', onceDate: '2026-11-05' }, DAY('2026-10-29', '08:00'))
    expect(target).toBe(DAY('2026-11-05', '08:30'))
  })

  it('date already past: never fires (the scheduler turns it off)', () => {
    expect(nextRun({ time: '08:30', onceDate: '2026-10-01' }, DAY('2026-10-29', '08:00'))).toBeNull()
  })

  it('invalid date: null instead of guessing', () => {
    expect(nextRun({ time: '08:30', onceDate: '31/10/2026' }, DAY('2026-10-29', '08:00'))).toBeNull()
  })

  it('takes precedence over intervalHours when both are filled in', () => {
    const target = nextRun(
      { time: '08:30', onceDate: '2026-11-05', intervalHours: 4 },
      DAY('2026-10-29', '08:00'),
    )
    expect(target).toBe(DAY('2026-11-05', '08:30'))
  })
})

describe('upcomingRuns', () => {
  const routine = (schedule: Schedule, active = true): Routine => ({
    id: 'r',
    title: 't',
    prompt: 'p',
    schedule,
    model: { providerId: 'p', modelId: 'm' },
    modes: { permissionMode: 'approve' },
    folders: [],
    active,
    createdAt: 0,
  })

  it('lists each firing of the window in order', () => {
    // Daily at 09:00, from the 29th 00:00 to the 1st 00:00: three firings
    const runs = upcomingRuns(routine({ time: '09:00' }), DAY('2026-10-29', '00:00'), DAY('2026-11-01', '00:00'))
    expect(runs).toEqual([DAY('2026-10-29', '09:00'), DAY('2026-10-30', '09:00'), DAY('2026-10-31', '09:00')])
  })

  it('includes a firing exactly at the start and excludes one exactly at the end', () => {
    const runs = upcomingRuns(routine({ time: '09:00' }), DAY('2026-10-29', '09:00'), DAY('2026-10-30', '09:00'))
    expect(runs).toEqual([DAY('2026-10-29', '09:00')])
  })

  it('follows the marked weekdays', () => {
    // Monday and Thursday (1 and 4) at 12:00, from Sunday the 25th to Sunday the 1st
    const runs = upcomingRuns(routine({ time: '12:00', days: [1, 4] }), DAY('2026-10-25', '00:00'), DAY('2026-11-01', '00:00'))
    expect(runs).toEqual([DAY('2026-10-26', '12:00'), DAY('2026-10-29', '12:00')])
  })

  it('returns nothing for a paused routine unless asked for what it would do', () => {
    const paused = routine({ time: '09:00' }, false)
    const from = DAY('2026-10-29', '00:00')
    const until = DAY('2026-10-31', '00:00')
    expect(upcomingRuns(paused, from, until)).toEqual([])
    expect(upcomingRuns(paused, from, until, { includeInactive: true })).toHaveLength(2)
  })

  it('stops at the limit and with a one-time schedule that already passed', () => {
    const hourly = routine({ time: '00:00', intervalHours: 1 })
    expect(upcomingRuns(hourly, DAY('2026-10-29', '00:00'), DAY('2026-12-01', '00:00'), { limit: 5 })).toHaveLength(5)
    const once = routine({ time: '09:00', onceDate: '2026-10-01' })
    expect(upcomingRuns(once, DAY('2026-10-29', '00:00'), DAY('2026-11-29', '00:00'))).toEqual([])
  })
})
