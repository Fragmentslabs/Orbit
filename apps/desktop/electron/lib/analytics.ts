import path from 'node:path'
import type { ChatMessage, SessionInfo, TokenUsage } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type {
  AnalyticsDay,
  AnalyticsRange,
  AnalyticsSession,
  AnalyticsSummary,
  ModelDayBreakdown,
  ModelProjectSlice,
  ProjectBreakdown,
  ProjectDayBreakdown,
} from '@shared/analytics'
import { listKeys, readJson } from './storage'
import { projectIdOf } from './memory/domain'
import { folderInMainRepository } from './worktrees/main'

export function computeRange(range: AnalyticsRange): { since: number; until?: number } {
  const now = Date.now()
  if (typeof range === 'object' && range.type === 'custom') {
    return { since: range.from, until: range.to }
  }
  switch (range) {
    case 'today': {
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      return { since: startOfDay.getTime() }
    }
    case '7d':
      return { since: now - 7 * 24 * 60 * 60 * 1000 }
    case '30d':
      return { since: now - 30 * 24 * 60 * 60 * 1000 }
    case 'total':
    default:
      return { since: 0 }
  }
}

/** Sessions without a working folder (chat mode) fall into this bucket. */
const NO_PROJECT_ID = '__chat__'

function getDateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function sumTokens(t: TokenUsage | undefined): number {
  if (!t) return 0
  return (t.input ?? 0) + (t.output ?? 0)
}

/** Only the text the person typed (ignores text extracted from an attachment) — used
 *  to decide whether a follow-up "looks like" a test/detailed implementation. */
function visibleTextLength(message: ChatMessage): number {
  return message.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text' && p.source !== 'attachment')
    .reduce((sum, p) => sum + p.text.length, 0)
}

interface WorkSegment {
  day: string
  /** Instant when the stretch begins — allows cutting by period without
   *  depending on the session's createdAt, which may be much earlier. */
  at: number
  ms: number
  /** 'orbit': the agent answering. 'user': the counted gap before the user's next message (an estimate of their active time). */
  kind: 'orbit' | 'user'
  providerId: string
  modelId: string
}

/**
 * Time worked = distance between consecutive messages, with rules to
 * decide whether the gap between an Orbit answer and the next message from the
 * user still counts as work or is a pause:
 * - Orbit answer (user → assistant): always counts (active generation).
 * - gap < 30min: counts whole (reading/testing/reviewing).
 * - gap 30–60min AND next msg > 300 chars: counts whole (detailed follow-up).
 * - gap 60–90min AND next msg > 1000 chars: counts 50% of the gap.
 * - any other case (gap > 90min, or gap 30–90min without a long enough
 *   message): breaks — does not count.
 */
function computeSessionSegments(messages: ChatMessage[]): WorkSegment[] {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt)
  const segments: WorkSegment[] = []

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    const gapMs = curr.createdAt - prev.createdAt
    if (gapMs <= 0) continue

    if (prev.role === 'user' && curr.role === 'assistant') {
      segments.push({
        day: getDateKey(prev.createdAt),
        at: prev.createdAt,
        ms: gapMs,
        kind: 'orbit',
        providerId: curr.providerId ?? 'unknown',
        modelId: curr.modelId ?? 'unknown',
      })
      continue
    }

    if (prev.role === 'assistant' && curr.role === 'user') {
      const gapMin = gapMs / 60_000
      const len = visibleTextLength(curr)
      let countedMs = 0
      if (gapMin < 30) countedMs = gapMs
      else if (gapMin <= 60 && len > 300) countedMs = gapMs
      else if (gapMin <= 90 && len > 1000) countedMs = gapMs * 0.5

      if (countedMs > 0) {
        segments.push({
          day: getDateKey(prev.createdAt),
          at: prev.createdAt,
          ms: countedMs,
          kind: 'user',
          providerId: prev.providerId ?? 'unknown',
          modelId: prev.modelId ?? 'unknown',
        })
      }
    }
  }

  return segments
}

/** The window right before the one asked for, with the same length — what the deltas compare with. */
function previousWindow(range: AnalyticsRange, since: number, until: number | undefined): { since: number; until: number } | undefined {
  if (range === 'total') return undefined
  if (range === 'today') {
    // Same hours of yesterday: comparing a half day with a whole one would always show a drop.
    const DAY_MS = 86_400_000
    return { since: since - DAY_MS, until: since - DAY_MS + (Date.now() - since) }
  }
  const length = (until ?? Date.now()) - since
  return { since: since - length - 1, until: since - 1 }
}

interface Accumulator {
  since: number
  until: number
  /** The history list is only built for the screen that shows it (not for the phone, nor for the comparison). */
  collectSessions: boolean
  dayMap: Map<string, AnalyticsDay>
  modelTotals: Map<string, ModelDayBreakdown>
  /** model → project → what the model did there (attached to the totals at the end). */
  modelProjects: Map<string, Map<string, ModelProjectSlice>>
  projectTotals: Map<string, ProjectBreakdown>
  hourCounts: number[]
  sessions: AnalyticsSession[]
  sessionsWithActivity: number
  totalMessages: number
  totalTokens: number
}

function newAccumulator(since: number, until: number | undefined, collectSessions: boolean): Accumulator {
  return {
    since,
    until: until ?? Number.POSITIVE_INFINITY,
    collectSessions,
    dayMap: new Map(),
    modelTotals: new Map(),
    modelProjects: new Map(),
    projectTotals: new Map(),
    hourCounts: new Array<number>(24).fill(0),
    sessions: [],
    sessionsWithActivity: 0,
    totalMessages: 0,
    totalTokens: 0,
  }
}

function modelProjectSlice(acc: Accumulator, modelKey: string, projectId: string): ModelProjectSlice {
  let byProject = acc.modelProjects.get(modelKey)
  if (!byProject) {
    byProject = new Map()
    acc.modelProjects.set(modelKey, byProject)
  }
  let slice = byProject.get(projectId)
  if (!slice) {
    slice = { projectId, hours: 0, tokens: 0, messages: 0, cost: 0 }
    byProject.set(projectId, slice)
  }
  return slice
}

/** Adds one conversation's messages (already read) to the totals of a period. */
function addSession(
  acc: Accumulator,
  session: SessionInfo,
  history: ChatMessage[],
  projectId: string,
  projectFolder: string | undefined,
): void {
  const { since, until: upperBound } = acc

  // The period cuts MESSAGES, not the session's creation date. Filtering
  // by session made "last 7 days" hide this week's work in a
  // conversation opened last month and, at the same time, add the whole
  // history of a conversation created yesterday.
  const messages = history.filter((m) => m.createdAt >= since && m.createdAt <= upperBound)
  if (messages.length === 0) return
  acc.sessionsWithActivity++

  for (const msg of messages) acc.hourCounts[new Date(msg.createdAt).getHours()]++

  let pt = acc.projectTotals.get(projectId)
  if (!pt) {
    pt = {
      projectId,
      name: projectFolder ? path.basename(projectFolder) : '',
      directory: projectFolder,
      hours: 0,
      orbitHours: 0,
      userHours: 0,
      tokens: 0,
      messages: 0,
      cost: 0,
      sessions: 0,
    }
    acc.projectTotals.set(projectId, pt)
  }
  pt.sessions++

  // Group messages by day for hours estimation
  const msgsByDay = new Map<string, ChatMessage[]>()
  for (const msg of messages) {
    const day = getDateKey(msg.createdAt)
    const bucket = msgsByDay.get(day) ?? []
    bucket.push(msg)
    msgsByDay.set(day, bucket)
  }

  /** This project's slice within a day — the heatmap filters by it. */
  const projectSlice = (entry: AnalyticsDay): ProjectDayBreakdown => {
    let slice = entry.byProject.find((p) => p.projectId === projectId)
    if (!slice) {
      slice = { projectId, hours: 0, orbitHours: 0, userHours: 0, tokens: 0, messages: 0, cost: 0 }
      entry.byProject.push(slice)
    }
    return slice
  }

  /** This conversation on each day — the history entry. */
  const sessionDays = new Map<string, AnalyticsSession>()
  const sessionModelCounts = new Map<string, Map<string, number>>()

  for (const [day, msgs] of msgsByDay) {
    msgs.sort((a, b) => a.createdAt - b.createdAt)

    let entry = acc.dayMap.get(day)
    if (!entry) {
      entry = {
        date: day,
        totalTokens: 0,
        totalHours: 0,
        orbitHours: 0,
        userHours: 0,
        sessions: 0,
        totalMessages: 0,
        totalCost: 0,
        byModel: [],
        byProject: [],
      }
      acc.dayMap.set(day, entry)
    }
    entry.sessions++

    const sessionDay: AnalyticsSession = {
      id: session.id,
      title: session.title,
      projectId,
      date: day,
      startAt: msgs[0].createdAt,
      endAt: msgs[msgs.length - 1].createdAt,
      hours: 0,
      orbitHours: 0,
      userHours: 0,
      messages: 0,
      tokens: 0,
      cost: 0,
      providerId: 'unknown',
      modelId: 'unknown',
    }
    sessionDays.set(day, sessionDay)
    const modelCounts = new Map<string, number>()
    sessionModelCounts.set(day, modelCounts)

    for (const msg of msgs) {
      if (msg.role !== 'assistant') continue
      const tokens = sumTokens(msg.tokens)
      const cost = msg.tokens?.cost ?? 0
      entry.totalTokens += tokens
      entry.totalCost += cost
      acc.totalTokens += tokens
      entry.totalMessages++
      acc.totalMessages++

      pt.tokens += tokens
      pt.messages++
      pt.cost += cost

      sessionDay.messages++
      sessionDay.tokens += tokens
      sessionDay.cost += cost

      const ps = projectSlice(entry)
      ps.tokens += tokens
      ps.messages++
      ps.cost += cost

      const providerId = msg.providerId ?? 'unknown'
      const modelId = msg.modelId ?? 'unknown'
      const modelKey = `${providerId}::${modelId}`
      modelCounts.set(modelKey, (modelCounts.get(modelKey) ?? 0) + 1)

      let mb = entry.byModel.find((m) => `${m.providerId}::${m.modelId}` === modelKey)
      if (!mb) {
        mb = { providerId, modelId, tokens: 0, hours: 0, messages: 0, cost: 0 }
        entry.byModel.push(mb)
      }
      mb.tokens += tokens
      mb.messages++
      mb.cost += cost

      let mt = acc.modelTotals.get(modelKey)
      if (!mt) {
        mt = { providerId, modelId, tokens: 0, hours: 0, messages: 0, cost: 0 }
        acc.modelTotals.set(modelKey, mt)
      }
      mt.tokens += tokens
      mt.messages++
      mt.cost += cost

      const slice = modelProjectSlice(acc, modelKey, projectId)
      slice.tokens += tokens
      slice.messages++
      slice.cost += cost
    }
  }

  // Hours = distance between consecutive messages (generation + gaps that
  // pass the computeSessionSegments rules), no longer the first-to-last message
  // span of the day. Orchestration worker sessions come in normally (they are
  // not filtered) — each worker counts its own time.
  for (const segment of computeSessionSegments(history)) {
    if (segment.at < since || segment.at > upperBound) continue
    const entry = acc.dayMap.get(segment.day)
    if (!entry) continue // day with no message at all (should not happen)
    const hours = segment.ms / 3_600_000
    const orbit = segment.kind === 'orbit'
    entry.totalHours += hours
    if (orbit) entry.orbitHours += hours
    else entry.userHours += hours
    pt.hours += hours
    if (orbit) pt.orbitHours += hours
    else pt.userHours += hours
    const slice = projectSlice(entry)
    slice.hours += hours
    if (orbit) slice.orbitHours += hours
    else slice.userHours += hours

    const sessionDay = sessionDays.get(segment.day)
    if (sessionDay) {
      sessionDay.hours += hours
      if (orbit) sessionDay.orbitHours += hours
      else sessionDay.userHours += hours
    }

    const modelKey = `${segment.providerId}::${segment.modelId}`
    let mb = entry.byModel.find((m) => `${m.providerId}::${m.modelId}` === modelKey)
    if (!mb) {
      mb = { providerId: segment.providerId, modelId: segment.modelId, tokens: 0, hours: 0, messages: 0, cost: 0 }
      entry.byModel.push(mb)
    }
    mb.hours += hours
    modelProjectSlice(acc, modelKey, projectId).hours += hours
  }

  if (!acc.collectSessions) return
  for (const [day, sessionDay] of sessionDays) {
    const counts = sessionModelCounts.get(day)
    const top = counts && [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top) {
      const [providerId, modelId] = top[0].split('::')
      sessionDay.providerId = providerId
      sessionDay.modelId = modelId
    }
    acc.sessions.push(sessionDay)
  }
}

/** How many history entries the screen receives at most (newest first). */
const MAX_SESSION_ENTRIES = 1500

function finishAccumulator(acc: Accumulator): AnalyticsSummary {
  // Distribute model totals hours proportionally (approximation)
  for (const [modelKey, mt] of acc.modelTotals) {
    const dayHoursSum = [...acc.dayMap.values()].reduce(
      (sum, d) => sum + (d.byModel.find((m) => `${m.providerId}::${m.modelId}` === modelKey)?.hours ?? 0),
      0,
    )
    mt.hours = dayHoursSum
    const byProject = acc.modelProjects.get(modelKey)
    if (byProject) mt.byProject = [...byProject.values()].sort((a, b) => b.hours - a.hours)
  }

  const days = [...acc.dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const byModel = [...acc.modelTotals.values()].sort((a, b) => b.tokens - a.tokens)
  const byProject = [...acc.projectTotals.values()].sort((a, b) => b.hours - a.hours)

  // Stats
  const activeDays = days.filter((d) => d.totalMessages > 0).length
  const { currentStreak, longestStreak } = computeStreaks(days)

  // Peak hour: counted in the pass above, over the period's messages.
  const peakHour = acc.hourCounts.indexOf(Math.max(...acc.hourCounts))

  const sessions = acc.collectSessions
    ? [...acc.sessions].sort((a, b) => b.startAt - a.startAt).slice(0, MAX_SESSION_ENTRIES)
    : undefined

  return {
    days,
    byModel,
    byProject,
    totalSessions: acc.sessionsWithActivity,
    totalMessages: acc.totalMessages,
    totalTokens: acc.totalTokens,
    totalHours: days.reduce((s, d) => s + d.totalHours, 0),
    orbitHours: days.reduce((s, d) => s + d.orbitHours, 0),
    userHours: days.reduce((s, d) => s + d.userHours, 0),
    totalCost: days.reduce((s, d) => s + d.totalCost, 0),
    activeDays,
    currentStreak,
    longestStreak,
    peakHour,
    ...(sessions ? { sessions } : {}),
  }
}

export interface ComputeAnalyticsOptions {
  /**
   * What only the desktop screen shows: the history of conversations, the comparison with the
   * previous period and the last year. The phone does not ask for it — each extra window is
   * another cut over every message read.
   */
  detailed?: boolean
  /** Only the conversations of one mode; absent = both. */
  mode?: 'chat' | 'code'
}

export async function computeAnalytics(
  range: AnalyticsRange,
  options: ComputeAnalyticsOptions = {},
): Promise<AnalyticsSummary> {
  const { since, until } = computeRange(range)
  const detailed = options.detailed === true

  const main = newAccumulator(since, until, detailed)
  const previousSpan = detailed ? previousWindow(range, since, until) : undefined
  const previous = previousSpan ? newAccumulator(previousSpan.since, previousSpan.until, false) : undefined
  // 53 weeks back from today: the activity card shows a full year whatever period is chosen.
  const year = detailed ? newAccumulator(Date.now() - 53 * 7 * 86_400_000, undefined, false) : undefined
  const accumulators = [main, previous, year].filter((a): a is Accumulator => a !== undefined)

  const sessionKeys = await listKeys(StorageKeys.sessionPrefix)

  for (const key of sessionKeys) {
    const session = await readJson<SessionInfo>(key)
    if (!session) continue
    if (options.mode && session.mode !== options.mode) continue
    // One read per session: the complete history serves the hour segments
    // (an interval may cross the period's border) and the cut comes from
    // it, without a second pass over the disk. The same read feeds the
    // comparison window and the year.
    const history = await readJson<ChatMessage[]>(StorageKeys.messages(session.id))
    if (!history) continue

    // The session's project: directory in code mode; chat without a folder = its own bucket.
    // A chat in a worktree counts in the main repository's project.
    const projectFolder = session.directory ? await folderInMainRepository(session.directory) : undefined
    const projectId = projectFolder ? projectIdOf(projectFolder) : NO_PROJECT_ID
    for (const acc of accumulators) addSession(acc, session, history, projectId, projectFolder)
  }

  const summary = finishAccumulator(main)
  if (!detailed) return summary

  if (previous) {
    const p = finishAccumulator(previous)
    summary.previous = {
      tokens: p.totalTokens,
      hours: p.totalHours,
      orbitHours: p.orbitHours,
      userHours: p.userHours,
      cost: p.totalCost,
      sessions: p.totalSessions,
      messages: p.totalMessages,
    }
  }
  if (year) {
    // Each day keeps its models and projects: the card opens a day as badges.
    const y = finishAccumulator(year)
    summary.year = y.days
    summary.yearProjects = y.byProject.map((p) => ({ projectId: p.projectId, name: p.name, directory: p.directory }))
  }
  return summary
}

function computeStreaks(days: AnalyticsDay[]): { currentStreak: number; longestStreak: number } {
  if (days.length === 0) return { currentStreak: 0, longestStreak: 0 }

  const activeDates = new Set(days.filter((d) => d.totalMessages > 0).map((d) => d.date))
  if (activeDates.size === 0) return { currentStreak: 0, longestStreak: 0 }

  // Build sorted unique dates
  const sorted = [...activeDates].sort()
  let longest = 1
  let current = 1

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1])
    const curr = new Date(sorted[i])
    const diffDays = (curr.getTime() - prev.getTime()) / 86_400_000
    if (Math.round(diffDays) === 1) {
      current++
      longest = Math.max(longest, current)
    } else {
      current = 1
    }
  }

  // Current streak: from today backwards
  const today = getDateKey(Date.now())
  let currentStreak = 0
  const d = new Date(today)
  while (activeDates.has(getDateKey(d.getTime()))) {
    currentStreak++
    d.setDate(d.getDate() - 1)
  }

  return { currentStreak, longestStreak: longest }
}

/* ------------------------------------------------------------------ *
 * Work report — the same hours count as the panel, but
 * cut by project and with what was talked about on each day,
 * so the agent can write "what was done" without inventing.
 * ------------------------------------------------------------------ */

export interface WorkReportSession {
  id: string
  title: string
  hours: number
  messages: number
  /** Stretches of what the user asked on that day, in the order they asked. */
  prompts: string[]
}

export interface WorkReportDay {
  date: string
  hours: number
  messages: number
  tokens: number
  cost: number
  /** First and last message of the day (ms) — it gives the start/end time. */
  firstAt: number
  lastAt: number
  sessions: WorkReportSession[]
}

export interface WorkReportProject {
  projectId: string
  name: string
  directory?: string
  hours: number
  tokens: number
  cost: number
  messages: number
  sessions: number
  days: WorkReportDay[]
}

export interface WorkReport {
  since: number
  until: number
  projects: WorkReportProject[]
  totalHours: number
  totalTokens: number
  totalCost: number
  /** Names of all projects with activity in the period, even the ones the
   *  filter discarded — it is what allows answering "that project does not exist,
   *  the ones that exist are these". */
  knownProjects: string[]
}

export interface WorkReportOptions {
  since: number
  until: number
  /** Matches the full path or the folder name, case-insensitively. */
  project?: string
  /** How many prompts to keep per session/day. 0 turns off the summary of what was done. */
  promptsPerDay?: number
}

/** Visible text of a message (without what came from an attachment), on a single line. */
function visibleText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text' && p.source !== 'attachment')
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Matches the filter with the session's folder by path SEGMENT, never by a loose
 * substring: with "orbit", a substring would bring "orbit-legacy" along and the
 * report would add hours from a project nobody asked for. A filter with a
 * slash is treated as a path stretch ("projects/orbit").
 */
function matchesProject(session: SessionInfo, filter: string): boolean {
  const target = normalizePath(filter)
  if (!session.directory) return target === '__chat__' || target === 'no project'
  const dir = normalizePath(session.directory)
  if (target.includes('/')) return dir === target || dir.endsWith(`/${target}`)
  return dir.split('/').includes(target)
}

/** Lowercase, normal slashes and no trailing slash left over. */
function normalizePath(value: string): string {
  return value.toLowerCase().split('\\').join('/').replace(/\/+$/, '')
}

export async function computeWorkReport(options: WorkReportOptions): Promise<WorkReport> {
  const { since, until, project, promptsPerDay = 6 } = options

  const sessionKeys = await listKeys(StorageKeys.sessionPrefix)
  const projects = new Map<string, WorkReportProject>()
  const knownProjects = new Set<string>()

  for (const key of sessionKeys) {
    const session = await readJson<SessionInfo>(key)
    if (!session) continue
    const messages = await readJson<ChatMessage[]>(StorageKeys.messages(session.id))
    if (!messages || messages.length === 0) continue

    // The cut is by message, not by the session's createdAt: an old
    // session that continued this week has to show up in the week.
    const inPeriod = messages.filter((m) => m.createdAt >= since && m.createdAt <= until)
    if (inPeriod.length === 0) continue

    // A chat in a worktree counts in the main repository's project (name,
    // filter and totals), not as a separate project with the worktree's name.
    const projectFolder = session.directory ? await folderInMainRepository(session.directory) : undefined
    const name = projectFolder ? path.basename(projectFolder) : ''
    knownProjects.add(name || 'No project')
    if (project && !matchesProject({ ...session, directory: projectFolder }, project)) continue

    const projectId = projectFolder ? projectIdOf(projectFolder) : NO_PROJECT_ID
    let proj = projects.get(projectId)
    if (!proj) {
      proj = {
        projectId,
        name: name,
        directory: projectFolder,
        hours: 0,
        tokens: 0,
        cost: 0,
        messages: 0,
        sessions: 0,
        days: [],
      }
      projects.set(projectId, proj)
    }
    proj.sessions++

    const days = new Map<string, WorkReportDay>()
    const getDay = (ts: number): WorkReportDay => {
      const date = getDateKey(ts)
      let day = days.get(date)
      if (!day) {
        day = { date, hours: 0, messages: 0, tokens: 0, cost: 0, firstAt: ts, lastAt: ts, sessions: [] }
        days.set(date, day)
      }
      day.firstAt = Math.min(day.firstAt, ts)
      day.lastAt = Math.max(day.lastAt, ts)
      return day
    }
    const getSessionOfDay = (day: WorkReportDay): WorkReportSession => {
      let entry = day.sessions.find((s) => s.id === session.id)
      if (!entry) {
        entry = { id: session.id, title: session.title, hours: 0, messages: 0, prompts: [] }
        day.sessions.push(entry)
      }
      return entry
    }

    for (const msg of inPeriod) {
      const day = getDay(msg.createdAt)
      const entry = getSessionOfDay(day)
      if (msg.role === 'assistant') {
        const tokens = sumTokens(msg.tokens)
        day.tokens += tokens
        day.cost += msg.tokens?.cost ?? 0
        day.messages++
        entry.messages++
        proj.tokens += tokens
        proj.cost += msg.tokens?.cost ?? 0
        proj.messages++
      } else if (msg.role === 'user' && promptsPerDay > 0 && entry.prompts.length < promptsPerDay) {
        const text = visibleText(msg)
        if (text) entry.prompts.push(text.length > 400 ? `${text.slice(0, 400)}…` : text)
      }
    }

    // Hours: the same rules as the panel, cut by the period.
    for (const segment of computeSessionSegments(messages)) {
      if (segment.at < since || segment.at > until) continue
      const hours = segment.ms / 3_600_000
      const day = getDay(segment.at)
      day.hours += hours
      getSessionOfDay(day).hours += hours
      proj.hours += hours
    }

    for (const day of days.values()) {
      const existing = proj.days.find((d) => d.date === day.date)
      if (!existing) {
        proj.days.push(day)
        continue
      }
      existing.hours += day.hours
      existing.messages += day.messages
      existing.tokens += day.tokens
      existing.cost += day.cost
      existing.firstAt = Math.min(existing.firstAt, day.firstAt)
      existing.lastAt = Math.max(existing.lastAt, day.lastAt)
      existing.sessions.push(...day.sessions)
    }
  }

  const list = [...projects.values()].sort((a, b) => b.hours - a.hours)
  for (const proj of list) {
    proj.days.sort((a, b) => a.date.localeCompare(b.date))
    for (const day of proj.days) day.sessions.sort((a, b) => b.hours - a.hours)
  }

  return {
    since,
    until,
    projects: list,
    totalHours: list.reduce((s, p) => s + p.hours, 0),
    totalTokens: list.reduce((s, p) => s + p.tokens, 0),
    totalCost: list.reduce((s, p) => s + p.cost, 0),
    knownProjects: [...knownProjects].sort(),
  }
}
