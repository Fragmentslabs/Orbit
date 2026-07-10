export interface ModelDayBreakdown {
  providerId: string
  modelId: string
  tokens: number
  hours: number
  messages: number
}

export interface AnalyticsDay {
  date: string
  totalTokens: number
  totalHours: number
  totalMessages: number
  byModel: ModelDayBreakdown[]
}

export interface AnalyticsSummary {
  days: AnalyticsDay[]
  byModel: ModelDayBreakdown[]
  totalSessions: number
  totalMessages: number
  totalTokens: number
  totalHours: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  peakHour: number
  favoriteModel: { providerId: string; modelId: string; messages: number }
}

export type AnalyticsRange = 'total' | '30d' | '7d' | 'today'
