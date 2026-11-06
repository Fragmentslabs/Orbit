/** What one model did inside one project, over the whole period. */
export interface ModelProjectSlice {
  projectId: string
  hours: number
  tokens: number
  messages: number
  cost: number
}

export interface ModelDayBreakdown {
  providerId: string
  modelId: string
  tokens: number
  hours: number
  messages: number
  cost: number
  /** Only on the period totals (`AnalyticsSummary.byModel`): where the model was used. */
  byProject?: ModelProjectSlice[]
}

/** The same day seen per project — what the heatmap uses when the filter leaves
 *  "all" and starts showing the hours spent in a single project. */
export interface ProjectDayBreakdown {
  projectId: string
  /** Work time: Orbit generating + the user's counted gaps (`orbitHours` + `userHours`). */
  hours: number
  /** Time the agent spent answering (user message → assistant answer). */
  orbitHours: number
  /** Estimate of the time the user was active: the counted gaps between an answer and the next message. */
  userHours: number
  tokens: number
  messages: number
  cost: number
}

export interface AnalyticsDay {
  date: string
  totalTokens: number
  /** Work time (`orbitHours` + `userHours`) — what the charts and the heatmap draw. */
  totalHours: number
  orbitHours: number
  userHours: number
  /** Conversations with activity on the day. */
  sessions: number
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
  orbitHours: number
  userHours: number
  tokens: number
  messages: number
  cost: number
  sessions: number
}

/**
 * One conversation on one day: the unit of the history. A conversation that
 * continued over three days shows up as three entries, each with the work of its day.
 */
export interface AnalyticsSession {
  id: string
  title: string
  projectId: string
  /** Day (YYYY-MM-DD) this entry covers. */
  date: string
  /** First and last message of the conversation inside that day (ms). */
  startAt: number
  endAt: number
  hours: number
  orbitHours: number
  userHours: number
  /** Assistant answers in the day. */
  messages: number
  tokens: number
  cost: number
  /** Model with the most answers in the day. */
  providerId: string
  modelId: string
}

/** The numbers the period is compared with (the previous one, with the same length). */
export interface AnalyticsPeriodTotals {
  tokens: number
  hours: number
  orbitHours: number
  userHours: number
  cost: number
  sessions: number
  messages: number
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
  /** Split of `totalHours`: the agent answering, and the user's counted gaps (an estimate). */
  orbitHours: number
  userHours: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  peakHour: number
  /** Only with `detailed` (the desktop screen; the phone does not ask for it). */
  sessions?: AnalyticsSession[]
  /** The period before this one, same length. Absent for "total". */
  previous?: AnalyticsPeriodTotals
  /** The last 53 weeks, whatever the period is — the activity card (with each day's models and projects). */
  year?: AnalyticsDay[]
  /** Names of the projects that appear in `year`, which may include some outside the period. */
  yearProjects?: Array<{ projectId: string; name: string; directory?: string }>
}

/** Period chosen in the date range picker (ms, bounds already at the start/end of the day). */
export interface CustomAnalyticsRange {
  type: 'custom'
  from: number
  to: number
}

export type AnalyticsRange = 'total' | '30d' | '7d' | 'today' | CustomAnalyticsRange

/** What "summarize the work" asks for: a project (or all) on a day or over the period. */
export interface UsageSummaryRequest {
  /** The project's id as the usage screen has it; null = every project. */
  projectId: string | null
  /** A day (YYYY-MM-DD) wins over the period. */
  day?: string
  range?: AnalyticsRange
  language?: string
}

export type UsageSummaryResponse =
  | { ok: true; text: string }
  | { ok: false; error: 'no-aux-model' | 'nothing' | 'failed'; message?: string }
