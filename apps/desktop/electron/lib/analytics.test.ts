import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

/**
 * The hours report is what the agent reads when someone asks "how much have I
 * worked on project X". If it counts what is outside the requested period, or
 * attributes one project's time to another, the answer comes out wrong with a precise
 * face — that is why the cut and the separation by folder are tested here.
 */

const storage = new Map<string, unknown>()

vi.mock('./storage', () => ({
  listKeys: async (prefix: string) =>
    [...storage.keys()].filter((k) => k.startsWith(prefix)),
  readJson: async (key: string) => storage.get(key) ?? null,
}))

vi.mock('./memory/domain', () => ({
  projectIdOf: (dir: string) => dir.toLowerCase(),
}))

const { computeAnalytics, computeWorkReport } = await import('./analytics')

const DAY = (day: number, hour: number, minute = 0) =>
  new Date(2026, 2, day, hour, minute, 0, 0).getTime()

let seq = 0
function msg(role: 'user' | 'assistant', at: number, text: string): ChatMessage {
  return {
    id: `m${++seq}`,
    role,
    parts: [{ type: 'text', text: text }],
    createdAt: at,
    ...(role === 'assistant'
      ? { providerId: 'anthropic', modelId: 'opus', tokens: { input: 100, output: 50, cost: 0.25 } }
      : {}),
  } as ChatMessage
}

function saveSession(id: string, directory: string | undefined, messages: ChatMessage[]) {
  const session: SessionInfo = {
    id,
    title: `conversation ${id}`,
    mode: directory ? 'code' : 'chat',
    pinned: false,
    archived: false,
    folderId: null,
    directory,
    createdAt: messages[0].createdAt,
    updatedAt: messages[messages.length - 1].createdAt,
  }
  storage.set(`session/${id}`, session)
  storage.set(`messages/${id}`, messages)
}

beforeEach(() => {
  storage.clear()
  seq = 0
})

describe('computeWorkReport', () => {
  it('counts the generation and the short interval, and separates by project', async () => {
    // Project A: request 10:00 → answer 10:30 (30min of generation), reading of
    // 15min and a new request 10:45 → answer 11:00 (15min). Total: 1h.
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 10, 0), 'do this'),
      msg('assistant', DAY(10, 10, 30), 'done'),
      msg('user', DAY(10, 10, 45), 'now that other thing'),
      msg('assistant', DAY(10, 11, 0), 'done'),
    ])
    // Project B: half an hour on the same day.
    saveSession('b', '/repo/beta', [
      msg('user', DAY(10, 14, 0), 'another project'),
      msg('assistant', DAY(10, 14, 30), 'ok'),
    ])

    const r = await computeWorkReport({ since: DAY(10, 0), until: DAY(10, 23, 59) })

    expect(r.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(r.projects[0].hours).toBeCloseTo(1, 5)
    expect(r.projects[1].hours).toBeCloseTo(0.5, 5)
    expect(r.totalHours).toBeCloseTo(1.5, 5)
  })

  it('does not count the long gap between an answer and the next request', async () => {
    // A 2h lunch in the middle: the two ends count, the gap does not.
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(11, 9, 0), 'morning'),
      msg('assistant', DAY(11, 10, 0), 'ok'),
      msg('user', DAY(11, 12, 0), 'afternoon'),
      msg('assistant', DAY(11, 13, 0), 'ok'),
    ])

    const r = await computeWorkReport({ since: DAY(11, 0), until: DAY(11, 23, 59) })
    expect(r.totalHours).toBeCloseTo(2, 5)
  })

  it('clips by the period even when the session started earlier', async () => {
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'day one'),
      msg('assistant', DAY(10, 10, 0), 'ok'),
      msg('user', DAY(12, 9, 0), 'day three'),
      msg('assistant', DAY(12, 9, 30), 'ok'),
    ])

    const r = await computeWorkReport({ since: DAY(12, 0), until: DAY(12, 23, 59) })
    expect(r.projects).toHaveLength(1)
    expect(r.totalHours).toBeCloseTo(0.5, 5)
    expect(r.projects[0].days.map((d) => d.date)).toEqual(['2026-03-12'])
  })

  it('stores what the user asked on each day and the cost of the day', async () => {
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'ship the chart by project'),
      msg('assistant', DAY(10, 9, 30), 'ok'),
    ])

    const r = await computeWorkReport({ since: DAY(10, 0), until: DAY(10, 23, 59) })
    const day = r.projects[0].days[0]
    expect(day.sessions[0].prompts).toEqual(['ship the chart by project'])
    expect(day.cost).toBeCloseTo(0.25, 5)
    expect(day.messages).toBe(1)
  })

  it('does not confuse a project with the neighboring folder of a similar name', async () => {
    // A substring would catch both and the total would come out inflated with hours of a
    // project nobody asked for.
    saveSession('a', '/repo/orbit', [
      msg('user', DAY(10, 9, 0), 'hi'),
      msg('assistant', DAY(10, 10, 0), 'ok'),
    ])
    saveSession('b', '/repo/orbit-legacy', [
      msg('user', DAY(10, 14, 0), 'hi'),
      msg('assistant', DAY(10, 15, 0), 'ok'),
    ])

    const r = await computeWorkReport({
      since: DAY(10, 0),
      until: DAY(10, 23, 59),
      project: 'orbit',
    })
    expect(r.projects.map((p) => p.name)).toEqual(['orbit'])
    expect(r.totalHours).toBeCloseTo(1, 5)
  })

  it('filters by folder name and lists the existing projects when nothing matches', async () => {
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'hi'),
      msg('assistant', DAY(10, 9, 30), 'ok'),
    ])
    saveSession('b', '/repo/beta', [
      msg('user', DAY(10, 14, 0), 'hi'),
      msg('assistant', DAY(10, 14, 30), 'ok'),
    ])

    const correct = await computeWorkReport({
      since: DAY(10, 0),
      until: DAY(10, 23, 59),
      project: 'beta',
    })
    expect(correct.projects.map((p) => p.name)).toEqual(['beta'])

    const wrong = await computeWorkReport({
      since: DAY(10, 0),
      until: DAY(10, 23, 59),
      project: 'gama',
    })
    expect(wrong.projects).toHaveLength(0)
    expect(wrong.knownProjects).toEqual(['alpha', 'beta'])
  })
})

describe('computeAnalytics', () => {
  it('clips by message, not by the conversation creation date', async () => {
    // The conversation was born on the 10th and went on to the 12th. Asking for the 12th only
    // has to bring the work of the 12th — and nothing from the 10th.
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'day one'),
      msg('assistant', DAY(10, 10, 0), 'ok'),
      msg('user', DAY(12, 9, 0), 'day three'),
      msg('assistant', DAY(12, 9, 30), 'ok'),
    ])

    const r = await computeAnalytics({ type: 'custom', from: DAY(12, 0), to: DAY(12, 23, 59) })
    expect(r.days.map((d) => d.date)).toEqual(['2026-03-12'])
    expect(r.totalHours).toBeCloseTo(0.5, 5)
    expect(r.totalMessages).toBe(1)
    expect(r.totalSessions).toBe(1)
  })

  it('counts the old conversation that continued within the period', async () => {
    // It was what the filter by createdAt hid: a session created before the
    // window, work inside it.
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(1, 9, 0), 'last month'),
      msg('assistant', DAY(1, 10, 0), 'ok'),
      msg('user', DAY(20, 9, 0), 'now'),
      msg('assistant', DAY(20, 10, 0), 'ok'),
    ])

    const r = await computeAnalytics({ type: 'custom', from: DAY(19, 0), to: DAY(21, 23, 59) })
    expect(r.totalSessions).toBe(1)
    expect(r.totalHours).toBeCloseTo(1, 5)
    expect(r.byProject[0].name).toBe('alpha')
  })

  it('opens the day by project, so the heatmap reads one day per folder', async () => {
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'hi'),
      msg('assistant', DAY(10, 10, 0), 'ok'),
    ])
    saveSession('b', '/repo/beta', [
      msg('user', DAY(10, 14, 0), 'hi'),
      msg('assistant', DAY(10, 14, 30), 'ok'),
    ])

    const r = await computeAnalytics({ type: 'custom', from: DAY(10, 0), to: DAY(10, 23, 59) })
    const day = r.days[0]
    expect(day.byProject).toHaveLength(2)
    // The day's slice is filtered by the SAME project id the top uses — it is the
    // contract the heatmap depends on. The id is a hash of the path, not the
    // path: comparing with '/repo/alpha' would never match, on any system.
    const alphaId = r.byProject.find((p) => p.name === 'alpha')!.projectId
    const alpha = day.byProject.find((p) => p.projectId === alphaId)
    expect(alpha?.hours).toBeCloseTo(1, 5)
    expect(alpha?.messages).toBe(1)
  })
})

describe('computeAnalytics: orbit and user hours', () => {
  it('splits the work time between the agent answering and the counted gap before the user', async () => {
    // 09:00 user → 09:40 answer (40 min of Orbit), 09:40 → 09:50 gap before the next message (10 min of the user)
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'go'),
      msg('assistant', DAY(10, 9, 40), 'ok'),
      msg('user', DAY(10, 9, 50), 'more'),
      msg('assistant', DAY(10, 10, 0), 'ok'),
    ])

    const r = await computeAnalytics({ type: 'custom', from: DAY(10, 0), to: DAY(10, 23, 59) })
    expect(r.orbitHours).toBeCloseTo(50 / 60, 5)
    expect(r.userHours).toBeCloseTo(10 / 60, 5)
    // The total is still what the charts always drew: the sum of both.
    expect(r.totalHours).toBeCloseTo(1, 5)
    expect(r.days[0].orbitHours + r.days[0].userHours).toBeCloseTo(r.days[0].totalHours, 5)
    expect(r.byProject[0].orbitHours).toBeCloseTo(50 / 60, 5)
    expect(r.byProject[0].userHours).toBeCloseTo(10 / 60, 5)
    expect(r.days[0].byProject[0].userHours).toBeCloseTo(10 / 60, 5)
  })

  it('does not count a long pause as the user being active', async () => {
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'go'),
      msg('assistant', DAY(10, 9, 10), 'ok'),
      msg('user', DAY(10, 13, 0), 'back'),
      msg('assistant', DAY(10, 13, 10), 'ok'),
    ])
    const r = await computeAnalytics({ type: 'custom', from: DAY(10, 0), to: DAY(10, 23, 59) })
    expect(r.userHours).toBe(0)
    expect(r.orbitHours).toBeCloseTo(20 / 60, 5)
  })
})

describe('computeAnalytics: detailed', () => {
  it('keeps the phone payload as it was: no history, comparison or year', async () => {
    saveSession('a', '/repo/alpha', [msg('user', DAY(10, 9, 0), 'go'), msg('assistant', DAY(10, 9, 10), 'ok')])
    const r = await computeAnalytics({ type: 'custom', from: DAY(10, 0), to: DAY(10, 23, 59) })
    expect(r.sessions).toBeUndefined()
    expect(r.previous).toBeUndefined()
    expect(r.year).toBeUndefined()
  })

  it('lists each conversation once per day, with the model that answered most', async () => {
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(10, 9, 0), 'day one'),
      msg('assistant', DAY(10, 9, 30), 'ok'),
      msg('user', DAY(11, 9, 0), 'day two'),
      msg('assistant', DAY(11, 9, 20), 'ok'),
    ])
    const r = await computeAnalytics({ type: 'custom', from: DAY(10, 0), to: DAY(11, 23, 59) }, { detailed: true })
    expect(r.sessions).toHaveLength(2)
    // Newest first
    expect(r.sessions!.map((s) => s.date)).toEqual(['2026-03-11', '2026-03-10'])
    const first = r.sessions![1]
    expect(first.title).toBe('conversation a')
    expect(first.messages).toBe(1)
    expect(first.cost).toBeCloseTo(0.25, 5)
    expect(first.modelId).toBe('opus')
    expect(first.orbitHours).toBeCloseTo(0.5, 5)
    expect(first.endAt).toBeGreaterThan(first.startAt)
  })

  it('shows where each model was used, by project', async () => {
    saveSession('a', '/repo/alpha', [msg('user', DAY(10, 9, 0), 'go'), msg('assistant', DAY(10, 10, 0), 'ok')])
    saveSession('b', '/repo/beta', [msg('user', DAY(10, 11, 0), 'go'), msg('assistant', DAY(10, 11, 30), 'ok')])
    const r = await computeAnalytics({ type: 'custom', from: DAY(10, 0), to: DAY(10, 23, 59) }, { detailed: true })
    const model = r.byModel[0]
    expect(model.byProject).toHaveLength(2)
    const alphaId = r.byProject.find((p) => p.name === 'alpha')!.projectId
    expect(model.byProject!.find((p) => p.projectId === alphaId)?.hours).toBeCloseTo(1, 5)
    expect(model.byProject!.reduce((s, p) => s + p.hours, 0)).toBeCloseTo(model.hours, 5)
  })

  it('compares with the window right before, with the same length', async () => {
    // Asked: the 12th. Previous: the 11th (same length).
    saveSession('a', '/repo/alpha', [
      msg('user', DAY(11, 9, 0), 'before'),
      msg('assistant', DAY(11, 9, 30), 'ok'),
      msg('user', DAY(12, 9, 0), 'now'),
      msg('assistant', DAY(12, 10, 0), 'ok'),
    ])
    const r = await computeAnalytics({ type: 'custom', from: DAY(12, 0), to: DAY(12, 23, 59) }, { detailed: true })
    expect(r.totalHours).toBeCloseTo(1, 5)
    expect(r.previous?.hours).toBeCloseTo(0.5, 5)
    expect(r.previous?.sessions).toBe(1)
    expect(r.previous?.cost).toBeCloseTo(0.25, 5)
  })

  it('has no previous period for "total"', async () => {
    saveSession('a', '/repo/alpha', [msg('user', DAY(10, 9, 0), 'go'), msg('assistant', DAY(10, 9, 10), 'ok')])
    const r = await computeAnalytics('total', { detailed: true })
    expect(r.previous).toBeUndefined()
  })
})

describe('computeAnalytics: mode filter', () => {
  it('keeps only the conversations of the asked mode', async () => {
    // saveSession marks a conversation as code when it has a folder, chat otherwise
    saveSession('code1', '/repo/alpha', [msg('user', DAY(10, 9, 0), 'go'), msg('assistant', DAY(10, 10, 0), 'ok')])
    saveSession('chat1', undefined, [msg('user', DAY(10, 11, 0), 'hi'), msg('assistant', DAY(10, 11, 30), 'ok')])
    const range = { type: 'custom' as const, from: DAY(10, 0), to: DAY(10, 23, 59) }

    const all = await computeAnalytics(range)
    const code = await computeAnalytics(range, { mode: 'code' })
    const chat = await computeAnalytics(range, { mode: 'chat' })

    expect(all.totalSessions).toBe(2)
    expect(code.totalSessions).toBe(1)
    expect(code.totalHours).toBeCloseTo(1, 5)
    expect(chat.totalSessions).toBe(1)
    expect(chat.totalHours).toBeCloseTo(0.5, 5)
  })
})

describe('computeAnalytics: sessions per day', () => {
  it('counts each conversation once on each day it had activity', async () => {
    saveSession('a', '/repo/alpha', [msg('user', DAY(10, 9, 0), 'go'), msg('assistant', DAY(10, 9, 10), 'ok')])
    saveSession('b', '/repo/alpha', [
      msg('user', DAY(10, 11, 0), 'go'),
      msg('assistant', DAY(10, 11, 10), 'ok'),
      msg('user', DAY(11, 11, 0), 'again'),
      msg('assistant', DAY(11, 11, 10), 'ok'),
    ])
    const r = await computeAnalytics({ type: 'custom', from: DAY(10, 0), to: DAY(11, 23, 59) })
    expect(r.days.map((d) => [d.date, d.sessions])).toEqual([
      ['2026-03-10', 2],
      ['2026-03-11', 1],
    ])
  })
})
