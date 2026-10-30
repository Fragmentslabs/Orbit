import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { computeAnalytics, computeWorkReport, type WorkReportProject } from '../analytics'

/**
 * Usage reports for the agent — the same math as the "Orbit usage" screen,
 * only in text, to answer questions like "how many hours did I work on
 * project X and what was done on each day?".
 *
 * The hour count is the panel's (generation time + the gaps between
 * messages that pass the session rules), so the two never diverge.
 * What was done comes from the conversation titles and the user's requests
 * on that day: it is real history, not a summary invented by the model.
 */

const PERIODO = {
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Start date, YYYY-MM-DD (inclusive). Omit to use "days".'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('End date, YYYY-MM-DD (inclusive). Defaults to today.'),
  days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Last N days counting today, when from/to are not given. Default: 30.'),
}

/** Local date from YYYY-MM-DD, or null if the day does not exist. The format
 *  passes the schema regex but "2026-13-01" and "2026-02-31" are not dates, and
 *  without this check they became NaN — which compares false with everything and made the
 *  report answer "no activity" instead of flagging the error. */
function parseDate(text: string): Date | null {
  const [year, month, day] = text.split('-').map(Number)
  const d = new Date(year, month - 1, day)
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return d
}

type Period = { since: number; until: number }

function resolvePeriod(input: { from?: string; to?: string; days?: number }): Period | string {
  const end = input.to ? parseDate(input.to) : new Date()
  if (!end) return `Error: "${input.to}" is not a valid date (use YYYY-MM-DD).`
  end.setHours(23, 59, 59, 999)

  if (input.from) {
    const start = parseDate(input.from)
    if (!start) return `Error: "${input.from}" is not a valid date (use YYYY-MM-DD).`
    start.setHours(0, 0, 0, 0)
    if (start.getTime() > end.getTime()) {
      return `Error: the start (${input.from}) is after the end (${input.to ?? 'today'}).`
    }
    return { since: start.getTime(), until: end.getTime() }
  }
  const start = new Date(end)
  start.setDate(start.getDate() - ((input.days ?? 30) - 1))
  start.setHours(0, 0, 0, 0)
  return { since: start.getTime(), until: end.getTime() }
}

const shortDate = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const timeOf = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const hoursOf = (h: number) => `${h.toFixed(2)}h`
const money = (c: number) => (c > 0 ? `$${c.toFixed(c < 1 ? 4 : 2)}` : '$0')
const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

/**
 * Cap on what one call returns. A year of detailed history goes past a
 * million characters — the result alone would overflow the context window,
 * taking down the conversation in which the question was asked. Cutting and SAYING that
 * it cut is better than returning everything: the model narrows the period and asks
 * again.
 */
const OUTPUT_LIMIT = 20_000

function cutAtLimit(lines: string[]): string {
  let total = 0
  for (let i = 0; i < lines.length; i++) {
    total += lines[i].length + 1
    if (total <= OUTPUT_LIMIT) continue
    return [
      ...lines.slice(0, i),
      '',
      `[report cut at ${i} of ${lines.length} lines for size. Narrow the period (from/to or days), name a project (project) or pass detail=false for hours only.]`,
    ].join('\n')
  }
  return lines.join('\n')
}

function writeProject(proj: WorkReportProject, withDetail: boolean): string[] {
  const lines: string[] = []
  const name = proj.name || 'No project (chat)'
  lines.push('')
  lines.push(`## ${name}${proj.directory ? ` — ${proj.directory}` : ''}`)
  lines.push(
    `Total: ${hoursOf(proj.hours)} · ${proj.days.length} day(s) · ${proj.sessions} conversation(s) · ${tokens(proj.tokens)} tokens · ${money(proj.cost)}`,
  )

  for (const day of proj.days) {
    lines.push('')
    lines.push(
      `### ${day.date} — ${hoursOf(day.hours)} (${timeOf(day.firstAt)}–${timeOf(day.lastAt)}, ${day.messages} reply(ies), ${money(day.cost)})`,
    )
    for (const session of day.sessions) {
      lines.push(`- "${session.title}" — ${hoursOf(session.hours)}`)
      if (!withDetail) continue
      for (const prompt of session.prompts) lines.push(`  · ${prompt}`)
    }
  }
  return lines
}

export function createUsageTools(): ToolSet {
  return {
    work_report: tool({
      description: [
        'Hours worked per day, taken from the real conversation history, optionally narrowed to one project.',
        'It reads the WHOLE history, not just the folder open in this conversation: with no project argument',
        'it sweeps every project and every chat, which is how it answers "what did I do this month" or finds',
        'work done in another repository without the user having to point at each folder.',
        'This is the tool for questions like "how many hours did I work on project X?" or',
        '"write me a report of what was done each day". It returns, per day: hours worked, the',
        'start and end time, which conversations were active, and what the user actually asked in them —',
        'so the day-by-day summary describes real work instead of being made up.',
        'Hours are the same ones shown on the Orbit Usage screen (generation time plus the gaps',
        'between messages that still count as working), so never recompute them by hand.',
        'If the project name matches nothing, the result lists the projects that do exist.',
      ].join(' '),
      inputSchema: z.object({
        project: z
          .string()
          .optional()
          .describe(
            'Project folder name, or a stretch of its path for two folders with the same name. Omit to sweep every project and chat, including ones unrelated to the folder open here. Use "no project" for chats with no working folder.',
          ),
        ...PERIODO,
        detail: z
          .boolean()
          .optional()
          .describe(
            'Default true: include what the user asked in each conversation. Pass false for hours only, which is also what keeps a long period small.',
          ),
      }),
      execute: async ({ project, from, to, days, detail }) => {
        const period = resolvePeriod({ from, to, days })
        if (typeof period === 'string') return period
        const { since, until } = period
        // The report crosses projects on purpose: the history is all of the
        // same user, and requiring them to point folder by folder to get the
        // detail would turn "what I did this month" into an interrogation.
        // It comes detailed by default; detail=false returns only the hours.
        const withDetail = detail !== false
        const report = await computeWorkReport({
          since,
          until,
          project,
          promptsPerDay: withDetail ? 6 : 0,
        })

        const header = `Period: ${shortDate(since)} to ${shortDate(until)}`
        if (report.projects.length === 0) {
          if (project) {
            return [
              `${header}. No activity in a project matching "${project}".`,
              report.knownProjects.length
                ? `Projects with activity in the period: ${report.knownProjects.join(', ')}.`
                : 'There was no activity at all in this period.',
            ].join('\n')
          }
          return `${header}. No activity recorded.`
        }

        const lines = [
          header,
          `Total: ${hoursOf(report.totalHours)} · ${tokens(report.totalTokens)} tokens · ${money(report.totalCost)}`,
        ]
        for (const proj of report.projects) lines.push(...writeProject(proj, withDetail))
        return cutAtLimit(lines)
      },
    }),

    usage_stats: tool({
      description: [
        'Token, cost and hour totals for a period, broken down by model, by project or by day.',
        'Use it for "how much did I spend", "which model did I use most", "cost per project".',
        'For what was DONE, or a day-by-day narrative, use work_report instead.',
      ].join(' '),
      inputSchema: z.object({
        groupBy: z.enum(['model', 'project', 'day']).optional().describe('Default: model'),
        ...PERIODO,
      }),
      execute: async ({ groupBy, from, to, days }) => {
        const period = resolvePeriod({ from, to, days })
        if (typeof period === 'string') return period
        const { since, until } = period
        const data = await computeAnalytics({ type: 'custom', from: since, to: until })
        const header = [
          `Period: ${shortDate(since)} to ${shortDate(until)}`,
          `Total: ${tokens(data.totalTokens)} tokens · ${hoursOf(data.totalHours)} · ${money(data.totalCost)} · ${data.totalSessions} conversation(s) · ${data.totalMessages} reply(ies)`,
        ]

        if (groupBy === 'project') {
          if (data.byProject.length === 0) return `${header.join('\n')}\nNo projects in the period.`
          return [
            ...header,
            'By project (name · hours · tokens · cost · conversations):',
            ...data.byProject.map(
              (p) =>
                `- ${p.name || 'No project (chat)'} · ${hoursOf(p.hours)} · ${tokens(p.tokens)} · ${money(p.cost)} · ${p.sessions}`,
            ),
          ].join('\n')
        }

        if (groupBy === 'day') {
          if (data.days.length === 0) return `${header.join('\n')}\nNo days with activity.`
          return [
            ...header,
            'By day (date · hours · tokens · cost):',
            ...data.days.map(
              (d) =>
                `- ${d.date} · ${hoursOf(d.totalHours)} · ${tokens(d.totalTokens)} · ${money(d.totalCost)}`,
            ),
          ].join('\n')
        }

        if (data.byModel.length === 0) return `${header.join('\n')}\nNo models in the period.`
        return [
          ...header,
          'By model (provider/model · tokens · hours · cost):',
          ...data.byModel.map(
            (m) =>
              `- ${m.providerId}/${m.modelId} · ${tokens(m.tokens)} · ${hoursOf(m.hours)} · ${money(m.cost)}`,
          ),
        ].join('\n')
      },
    }),
  }
}
