import { describe, expect, it } from 'vitest'
import { INDEX_CAP, rankSkills, type RankSkill, type UseEvent } from './ranking'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 31)
const OLD = NOW - 100 * DAY

const skill = (slug: string, createdAt = OLD): RankSkill => ({ slug, createdAt })
const use = (slug: string, sessionId: string, daysAgo = 1): UseEvent => ({
  slug,
  sessionId,
  at: NOW - daysAgo * DAY,
})
const rank = (
  skills: RankSkill[],
  events: UseEvent[] = [],
  prefs: Record<string, { pin?: number; never?: boolean }> = {},
) => rankSkills({ skills, events, prefs, now: NOW })
const slugs = (r: ReturnType<typeof rank>) => r.described.map((d) => d.slug)

describe('rankSkills', () => {
  it('lets a skill in with two conversations, not with one', () => {
    const skills = [skill('a'), skill('b')]
    const r = rank(skills, [use('b', 's1'), use('b', 's2')])
    expect(r.described.find((d) => d.slug === 'b')?.group).toBe('recent')
    expect(r.qualified).toBe(1)
    const single = rank(skills, [use('b', 's1'), use('b', 's1')])
    expect(single.qualified).toBe(0)
    expect(single.described.find((d) => d.slug === 'b')?.group).toBe('fill')
  })

  it('drops a skill after 14 days without use', () => {
    const r = rank([skill('a')], [use('a', 's1', 15), use('a', 's2', 16)])
    expect(r.qualified).toBe(0)
  })

  it('orders recurring by conversations, then recency, then name', () => {
    const events = [
      use('b', 's1'), use('b', 's2'),
      use('a', 's1'), use('a', 's2'),
      use('c', 's1'), use('c', 's2'), use('c', 's3', 5),
    ]
    expect(slugs(rank([skill('a'), skill('b'), skill('c')], events))).toEqual(['c', 'a', 'b'])
  })

  it('puts pins first, oldest pin first, and lets them pass the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => skill(`s${String(i).padStart(2, '0')}`))
    const prefs = Object.fromEntries(many.map((s, i) => [s.slug, { pin: 1000 - i }]))
    const r = rank(many, [], prefs)
    expect(r.described).toHaveLength(30)
    expect(r.namesOnly).toEqual([])
    expect(r.described[0].slug).toBe('s29')
  })

  it('reserves two seats for new, never-used skills', () => {
    const old = Array.from({ length: 30 }, (_, i) => skill(`o${String(i).padStart(2, '0')}`))
    const events = old.flatMap((s) => [use(s.slug, 'x'), use(s.slug, 'y')])
    const fresh = [skill('n1', NOW - 1 * DAY), skill('n2', NOW - 2 * DAY), skill('n3', NOW - 3 * DAY)]
    const r = rank([...old, ...fresh], events)
    const groups = r.described.map((d) => d.group)
    expect(r.described).toHaveLength(INDEX_CAP)
    expect(groups.filter((g) => g === 'new')).toHaveLength(2)
    expect(slugs(r)).toContain('n1')
    expect(slugs(r)).toContain('n2')
  })

  it('a new skill that was used becomes recent, not new', () => {
    const r = rank([skill('n', NOW - DAY)], [use('n', 's1'), use('n', 's2')])
    expect(r.described[0].group).toBe('recent')
  })

  it('a new skill used once is no longer new', () => {
    const r = rank([skill('n', NOW - DAY)], [use('n', 's1')])
    expect(r.described[0].group).toBe('fill')
    expect(r.qualified).toBe(0)
  })

  it('expires "new" after 14 days', () => {
    const r = rank([skill('n', NOW - 15 * DAY)])
    expect(r.qualified).toBe(0)
  })

  it('with 30 skills: 25 described, 5 by name, none missing, names alphabetical', () => {
    const all = Array.from({ length: 30 }, (_, i) => skill(`s${String(i).padStart(2, '0')}`))
    const r = rank([...all].reverse())
    expect(r.described).toHaveLength(25)
    expect(r.namesOnly).toEqual(['s25', 's26', 's27', 's28', 's29'])
    expect(new Set([...slugs(r), ...r.namesOnly]).size).toBe(30)
    expect(rank(all).namesOnly).toEqual(r.namesOnly)
  })

  it('"never" removes the skill from both layers', () => {
    const r = rank([skill('a'), skill('b')], [], { a: { never: true } })
    expect([...slugs(r), ...r.namesOnly]).toEqual(['b'])
  })

  it('a pin overrides "never"-less ranking and a skill is never listed twice', () => {
    const r = rank([skill('a')], [use('a', '1'), use('a', '2')], { a: { pin: 5 } })
    expect(r.described).toEqual([{ slug: 'a', group: 'pin' }])
  })

  it('ties break by name, so the result is stable', () => {
    const r = rank([skill('b'), skill('a')])
    expect(slugs(r)).toEqual(['a', 'b'])
  })
})
