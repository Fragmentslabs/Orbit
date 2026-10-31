import type { SkillPrefs } from '@shared/skills'

/**
 * The fixed list (the prompt index), as a pure function: no disk, no clock, no state.
 *
 * Two layers. The first `INDEX_CAP` skills of the ranking carry `@slug — summary`;
 * every other skill appears by name only. No name disappears — the model never loses
 * the existence of a skill, only its description.
 *
 * Who is in the first layer: pins, then the recurring (≥ 2 distinct conversations in
 * the last 14 days), then the new ones that were never used (2 seats reserved). The rest
 * of the cap is filled by plain ranking — and for skills never used that tie-break is
 * alphabetical, so beyond 25 *which* ones get a description is arbitrary, on purpose.
 *
 * No hysteresis: one window, inside it enters, outside it leaves. A "was on the list
 * until X" would be state this function does not have, and it would not change the result.
 */

export const INDEX_CAP = 25
export const NEW_RESERVED = 2
export const WINDOW_DAYS = 14
export const MIN_CONVERSATIONS = 2
const DAY_MS = 86_400_000

export interface RankSkill {
  slug: string
  /** When the file appeared (creation/import); decides "new" */
  createdAt: number
}

/** One use of a skill: opening it or citing it, in one conversation. */
export interface UseEvent {
  slug: string
  sessionId: string
  at: number
}

export type RankGroup = 'pin' | 'recent' | 'new' | 'fill'

export interface RankInput {
  /** The user's skills (built-ins never come here). */
  skills: readonly RankSkill[]
  /** Events already narrowed to the scope (repository, or global as the fallback). */
  events: readonly UseEvent[]
  prefs: Readonly<Record<string, SkillPrefs>>
  now: number
  cap?: number
  newReserved?: number
}

export interface RankResult {
  /** The first layer, in order, with the reason each one is there. */
  described: Array<{ slug: string; group: RankGroup }>
  /** The second layer: names only, alphabetical and stable. */
  namesOnly: string[]
  /** How many qualified by themselves (pin + recent + new) — the number to calibrate the cap with. */
  qualified: number
}

interface Usage {
  /** Distinct conversations inside the window */
  windowed: number
  lastAt: number
  /** Ever used (any time kept in the ledger) */
  everUsed: boolean
}

function usageOf(events: readonly UseEvent[], now: number): Map<string, Usage> {
  const since = now - WINDOW_DAYS * DAY_MS
  const sessions = new Map<string, Set<string>>()
  const out = new Map<string, Usage>()
  for (const event of events) {
    const usage = out.get(event.slug) ?? { windowed: 0, lastAt: 0, everUsed: true }
    usage.lastAt = Math.max(usage.lastAt, event.at)
    out.set(event.slug, usage)
    if (event.at < since) continue
    const set = sessions.get(event.slug) ?? new Set<string>()
    set.add(event.sessionId)
    sessions.set(event.slug, set)
  }
  for (const [slug, set] of sessions) out.get(slug)!.windowed = set.size
  return out
}

const bySlug = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function rankSkills(input: RankInput): RankResult {
  const cap = input.cap ?? INDEX_CAP
  const reserved = input.newReserved ?? NEW_RESERVED
  const usage = usageOf(input.events, input.now)
  const newSince = input.now - WINDOW_DAYS * DAY_MS

  const eligible = input.skills.filter((s) => !input.prefs[s.slug]?.never)
  const taken = new Set<string>()
  const described: RankResult['described'] = []
  const take = (slug: string, group: RankGroup) => {
    if (taken.has(slug)) return
    taken.add(slug)
    described.push({ slug, group })
  }

  // Pins first and without a ceiling: if they pass the cap, the pins win.
  const pins = eligible
    .filter((s) => input.prefs[s.slug]?.pin)
    .sort((a, b) => input.prefs[a.slug]!.pin! - input.prefs[b.slug]!.pin! || bySlug(a.slug, b.slug))
  for (const s of pins) take(s.slug, 'pin')

  const recents = eligible
    .filter((s) => !taken.has(s.slug) && (usage.get(s.slug)?.windowed ?? 0) >= MIN_CONVERSATIONS)
    .sort((a, b) => {
      const ua = usage.get(a.slug)!
      const ub = usage.get(b.slug)!
      return ub.windowed - ua.windowed || ub.lastAt - ua.lastAt || bySlug(a.slug, b.slug)
    })
  const news = eligible
    .filter((s) => !taken.has(s.slug) && !usage.get(s.slug)?.everUsed && s.createdAt >= newSince)
    .sort((a, b) => b.createdAt - a.createdAt || bySlug(a.slug, b.slug))
  const qualified = pins.length + recents.length + news.length

  const room = () => Math.max(0, cap - described.length)
  // Seats reserved for the new ones come off the top, so a crowd of recurring skills
  // cannot starve a skill that was just added.
  const newSeats = Math.min(reserved, news.length, room())
  const recentSeats = Math.min(recents.length, room() - newSeats)
  for (const s of recents.slice(0, recentSeats)) take(s.slug, 'recent')
  for (const s of news.slice(0, newSeats)) take(s.slug, 'new')
  // Seats the recurring ones did not need go to more new ones.
  for (const s of news.slice(newSeats)) if (room() > 0) take(s.slug, 'new')

  // Plain ranking for what is left of the cap: a single use beats none, then recency,
  // then the name. Nothing here counts as "qualified".
  const rest = eligible
    .filter((s) => !taken.has(s.slug))
    .sort((a, b) => {
      const ua = usage.get(a.slug)
      const ub = usage.get(b.slug)
      return (
        (ub?.windowed ?? 0) - (ua?.windowed ?? 0) || (ub?.lastAt ?? 0) - (ua?.lastAt ?? 0) || bySlug(a.slug, b.slug)
      )
    })
  for (const s of rest) if (room() > 0) take(s.slug, 'fill')

  const namesOnly = eligible.map((s) => s.slug).filter((slug) => !taken.has(slug)).sort(bySlug)
  return { described, namesOnly, qualified }
}
