export interface ModelDayBreakdown {
  providerId: string
  modelId: string
  tokens: number
  hours: number
  messages: number
  cost: number
}

/** The same day seen per project — what the heatmap uses when the filter leaves
 *  "all" and starts showing the hours spent in a single project. */
export interface ProjectDayBreakdown {
  projectId: string
  hours: number
  tokens: number
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
  byProject: ProjectDayBreakdown[]
}

export interface ProjectBreakdown {
  /** projectIdOf(directory) of the memories; "__chat__" for sessions without a folder */
  projectId: string
  /** Name of the project folder (basename of the directory) */
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

/** Period chosen in the date range picker (ms, bounds already at the start/end of the day). */
export interface CustomAnalyticsRange {
  type: 'custom'
  from: number
  to: number
}

export type AnalyticsRange = 'total' | '30d' | '7d' | 'today' | CustomAnalyticsRange
