import type { TFunction } from 'i18next'
import type { Schedule } from '@orbit/shared'
import { parseTime } from '@orbit/shared'

/** Pure schedule helpers for routines — mirror of the desktop's schedule.ts. */

export type ScheduleMode = 'daily' | 'weekly' | 'intervalDays' | 'intervalHours' | 'once'

export function scheduleMode(schedule: Schedule): ScheduleMode {
  // The precedence mirrors the one in the computation (nextRoutineRun).
  if (schedule.onceDate) return 'once'
  if (schedule.intervalHours && schedule.intervalHours > 0) return 'intervalHours'
  if (schedule.intervalDays && schedule.intervalDays > 1) return 'intervalDays'
  if (schedule.days?.length) return 'weekly'
  return 'daily'
}

/** Day initials for the toggle buttons (S M T W T F S). */
export function shortDays(t: TFunction): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => t(`routines.schedule.day.${d}`))
}

/** Three-letter abbreviations (Mon, Tue…) — the initials become "S, T, Q, Q, S"
 *  inside a sentence, which nobody can read. */
function abbreviatedDays(t: TFunction): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => t(`routines.schedule.dayAbbr.${d}`))
}

const WEEKDAYS = '1,2,3,4,5'
const WEEKEND = '0,6'

/** "2026-10-30" → "30/10/2026" (fixed format, independent of the locale). */
function formatDate(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/** Card sentence: "Every day at 09:00", "Mon, Wed, Fri at 18:30"… */
export function describeSchedule(schedule: Schedule, t: TFunction): string {
  const time = parseTime(schedule.time) ? schedule.time : '??:??'
  if (schedule.onceDate) {
    return t('routines.schedule.summarySingle', { date: formatDate(schedule.onceDate), time: time })
  }
  if (schedule.intervalHours && schedule.intervalHours > 0) {
    return t('routines.schedule.summaryHours', { hours: schedule.intervalHours })
  }
  if (schedule.intervalDays && schedule.intervalDays > 1) {
    return t('routines.schedule.summaryInterval', { days: schedule.intervalDays, time: time })
  }
  if (schedule.days?.length && schedule.days.length < 7) {
    const sorted = [...schedule.days].sort((a, b) => a - b)
    const key = sorted.join(',')
    // The two sets almost every routine uses get a name of their own: listing
    // "Mon, Tue, Wed, Thu, Fri" takes up the card's whole line without saying
    // anything more.
    if (key === WEEKDAYS) return t('routines.schedule.summaryWorkdays', { time: time })
    if (key === WEEKEND) return t('routines.schedule.summaryWeekend', { time: time })
    const names = abbreviatedDays(t)
    return t('routines.schedule.summaryDays', { days: sorted.map((d) => names[d]).join(', '), time: time })
  }
  return t('routines.schedule.summaryDaily', { time: time })
}
