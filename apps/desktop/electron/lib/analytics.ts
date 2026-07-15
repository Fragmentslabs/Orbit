import type { ChatMessage, SessionInfo, TokenUsage } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { AnalyticsDay, AnalyticsRange, AnalyticsSummary, ModelDayBreakdown } from '@shared/analytics'
import { listKeys, readJson } from './storage'

function computeRange(range: AnalyticsRange): { since: number } {
  const now = Date.now()
  switch (range) {
    case 'today':
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      return { since: startOfDay.getTime() }
    case '7d':
      return { since: now - 7 * 24 * 60 * 60 * 1000 }
    case '30d':
      return { since: now - 30 * 24 * 60 * 60 * 1000 }
    case 'total':
      return { since: 0 }
  }
}

function getDateKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function sumTokens(t: TokenUsage | undefined): number {
  if (!t) return 0
  return (t.input ?? 0) + (t.output ?? 0)
}

export async function computeAnalytics(range: AnalyticsRange): Promise<AnalyticsSummary> {
  const { since } = computeRange(range)

  const sessionKeys = await listKeys(StorageKeys.sessionPrefix)
  const sessions: SessionInfo[] = []

  for (const key of sessionKeys) {
    const session = await readJson<SessionInfo>(key)
    if (session && session.createdAt >= since) {
      sessions.push(session)
    }
  }

  const dayMap = new Map<string, AnalyticsDay>()
  const modelTotals = new Map<string, ModelDayBreakdown>()
  let totalMessages = 0
  let totalTokensVal = 0

  for (const session of sessions) {
    const messages = await readJson<ChatMessage[]>(StorageKeys.messages(session.id))
    if (!messages) continue

    // Group messages by day for hours estimation
    const msgsByDay = new Map<string, ChatMessage[]>()
    for (const msg of messages) {
      const day = getDateKey(msg.createdAt)
      const bucket = msgsByDay.get(day) ?? []
      bucket.push(msg)
      msgsByDay.set(day, bucket)
    }

    for (const [day, msgs] of msgsByDay) {
      msgs.sort((a, b) => a.createdAt - b.createdAt)
      const dayHours = Math.min(
        (msgs[msgs.length - 1].createdAt - msgs[0].createdAt) / 3_600_000,
        8,
      )

      let entry = dayMap.get(day)
      if (!entry) {
        entry = { date: day, totalTokens: 0, totalHours: 0, totalMessages: 0, totalCost: 0, byModel: [] }
        dayMap.set(day, entry)
      }

      for (const msg of msgs) {
        if (msg.role !== 'assistant') continue
        const tokens = sumTokens(msg.tokens)
        const cost = msg.tokens?.cost ?? 0
        entry.totalTokens += tokens
        entry.totalCost += cost
        totalTokensVal += tokens
        entry.totalMessages++
        totalMessages++

        const modelKey = `${msg.providerId ?? 'unknown'}::${msg.modelId ?? 'unknown'}`
        let mb = entry.byModel.find((m) => `${m.providerId}::${m.modelId}` === modelKey)
        if (!mb) {
          mb = { providerId: msg.providerId ?? 'unknown', modelId: msg.modelId ?? 'unknown', tokens: 0, hours: 0, messages: 0, cost: 0 }
          entry.byModel.push(mb)
        }
        mb.tokens += tokens
        mb.messages++
        mb.cost += cost

        let mt = modelTotals.get(modelKey)
        if (!mt) {
          mt = { providerId: msg.providerId ?? 'unknown', modelId: msg.modelId ?? 'unknown', tokens: 0, hours: 0, messages: 0, cost: 0 }
          modelTotals.set(modelKey, mt)
        }
        mt.tokens += tokens
        mt.messages++
        mt.cost += cost
      }

      // Distribute day hours proportionally to message count among models
      const assistantCount = msgs.filter((m) => m.role === 'assistant').length
      if (assistantCount > 0) {
        entry.totalHours += dayHours
        for (const mb of entry.byModel) {
          const modelAssistantCount = msgs.filter(
            (m) => m.role === 'assistant' && (m.modelId ?? 'unknown') === mb.modelId,
          ).length
          mb.hours += (dayHours * modelAssistantCount) / assistantCount
        }
      }
    }
  }

  // Distribute model totals hours proportionally (approximation)
  for (const [modelKey, mt] of modelTotals) {
    const dayHoursSum = [...dayMap.values()].reduce(
      (sum, d) => sum + (d.byModel.find((m) => `${m.providerId}::${m.modelId}` === modelKey)?.hours ?? 0),
      0,
    )
    mt.hours = dayHoursSum
  }

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  const byModel = [...modelTotals.values()].sort((a, b) => b.tokens - a.tokens)

  // Stats
  const activeDays = days.filter((d) => d.totalMessages > 0).length
  const { currentStreak, longestStreak } = computeStreaks(days)

  // Peak hour: count messages by hour of day
  const hourCounts = new Array(24).fill(0)
  for (const session of sessions) {
    const messages = await readJson<ChatMessage[]>(StorageKeys.messages(session.id))
    if (!messages) continue
    for (const msg of messages) {
      const h = new Date(msg.createdAt).getHours()
      hourCounts[h]++
    }
  }
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts))

  const totalHours = days.reduce((s, d) => s + d.totalHours, 0)
  const totalCost = days.reduce((s, d) => s + d.totalCost, 0)

  return {
    days,
    byModel,
    totalSessions: sessions.length,
    totalMessages,
    totalTokens: totalTokensVal,
    totalHours,
    totalCost,
    activeDays,
    currentStreak,
    longestStreak,
    peakHour,
  }
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
