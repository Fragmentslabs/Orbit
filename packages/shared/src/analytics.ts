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

export interface ProjectBreakdown {
  /** projectIdOf(directory) das memórias; "__chat__" para sessões sem pasta */
  projectId: string
  /** Nome da pasta do projeto (basename do directory) */
  name: string
  directory?: string
  hours: number
  tokens: number
  messages: number
  cost: number
  sessions: number
}

export interface AnalyticsSummary {
  days: AnalyticsDay[]
  byModel: ModelDayBreakdown[]
  byProject: ProjectBreakdown[]
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
