export interface ModelDayBreakdown {
  providerId: string
  modelId: string
  tokens: number
  hours: number
  messages: number
  cost: number
}

export interface AnalyticsDay {
  date: string
  totalTokens: number
  totalHours: number
  totalMessages: number
  totalCost: number
  byModel: ModelDayBreakdown[]
}

export interface AnalyticsSummary {
  days: AnalyticsDay[]
  byModel: ModelDayBreakdown[]
  totalSessions: number
  totalMessages: number
  totalTokens: number
  totalHours: number
  totalCost: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  peakHour: number
}

export type AnalyticsRange = 'total' | '30d' | '7d' | 'today'
