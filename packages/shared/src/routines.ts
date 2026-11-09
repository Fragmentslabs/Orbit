/**
 * Routines — chats that come back on their own, in chat and code modes.
 *
 * A routine is a prompt + a schedule. At the appointed time the main-process
 * scheduler creates a fresh chat session and dispatches it through the SAME
 * `chat:send` path (runChat / runChatWithLoop / runOrchestration): loop,
 * orchestration, per-message diff, permissions and the existing chat UI all
 * come for free.
 *
 * By default every execution is a session of its own (`routine_<id>_<ts>`,
 * carrying `routineId`), not a single conversation that keeps growing: that is
 * what makes the run history in the panel and the individual deletion from the
 * sidebar possible. A routine with `reuseChat` trades that for one chat that all
 * its executions continue (`chatSessionId`), for routines that fire often. "Remembering the previous day" is the Brain's job, enabled
 * through the routine's modes.
 *
 * The `mode` field separates the two worlds:
 *   - 'code': runs inside the working `folders`; every mode is available.
 *   - 'chat': no folders (conversation and chat tools only); the modes are
 *     restricted to the chat subset (ROUTINE_CHAT_MODES).
 * Each execution's session inherits the routine's mode, and the sidebar only
 * shows the "Routines" group of the matching mode.
 */

import type { PermissionMode, SendMessageOptions } from './chat'

/** Prefix of the session ids created by a routine. */
export const ROUTINE_SESSION_PREFIX = 'routine_'

/**
 * Prefix used before the domain was renamed to English. Sessions written back
 * then keep it, so anything that RECOGNISES a routine session must accept
 * both; only creation uses the new one.
 */
export const LEGACY_ROUTINE_SESSION_PREFIX = 'rotina_'

/** True when the session id was minted by a routine run (current or legacy prefix). */
export function isRoutineSessionId(id: string): boolean {
  return id.startsWith(ROUTINE_SESSION_PREFIX) || id.startsWith(LEGACY_ROUTINE_SESSION_PREFIX)
}

/**
 * A routine that keeps one chat has no ceiling on executions, but the history
 * is compacted as it grows. From this many compactions on, the next summary
 * would be a summary of a summary (same rule as the compaction card), so the
 * chat offers to be replaced by a fresh one.
 */
export const ROUTINE_CHAT_SUMMARY_LIMIT = 2

/** True when a reused routine chat has been compacted enough to offer a new one. */
export function routineChatIsFull(summaries: number): boolean {
  return summaries >= ROUTINE_CHAT_SUMMARY_LIMIT
}

// ─── Schedule ────────────────────────────────────────────────────────────────

/**
 * STRUCTURED schedule, not cron: the generator returns `{ time, days }` and
 * the next firing is computed by plain code (testable, no new dependency) — a
 * cron string would be impossible to edit in the review screen.
 */
export interface Schedule {
  /** "HH:MM" in the machine's local timezone */
  time: string
  /** Weekdays (0 = Sunday). Absent/empty = every day. */
  days?: number[]
  /** Alternative to `days`: every N days counted from the last execution. */
  intervalDays?: number
  /**
   * Alternative to `days`: every N hours counted from the last execution (the
   * first one lands on the next `time` of the day).
   */
  intervalHours?: number
  /**
   * One-time schedule: a date in "YYYY-MM-DD" (local timezone). Together with
   * `time` it forms the single firing — after it runs (or after the date
   * passes) the routine never fires again and the scheduler turns it off by
   * itself.
   *
   * Precedence when more than one field is filled in (schedules coming from a
   * hand-edited routines.json): `onceDate` > `intervalHours` > `intervalDays` >
   * `days`.
   */
  onceDate?: string
}

// ─── Modes ───────────────────────────────────────────────────────────────────

/**
 * Modes confirmed by the user in the review screen. It is a serializable
 * subset of SendMessageOptions — the rest of the options (planReview,
 * orchestration plan) is turn state, not routine configuration.
 */
export interface RoutineModes {
  loop?: boolean
  subagents?: boolean
  orchestrate?: boolean
  brain?: boolean
  simple?: boolean
  plan?: boolean
  browser?: boolean
  /** In-depth web research (options.research of chat:send) */
  search?: boolean
  /** Hands image description to the vision model (input.visionModel) */
  vision?: boolean
  /** "approve" (Autonomy) by default, the same default as a code chat. */
  permissionMode?: PermissionMode
}

/** Order in which the modes show up in the badges and in the editor. */
export const ROUTINE_MODES: (keyof Omit<RoutineModes, 'permissionMode'>)[] = [
  'brain',
  'loop',
  'subagents',
  'orchestrate',
  'browser',
  'plan',
  'simple',
  'search',
  'vision',
]

/**
 * Modes available in a chat-mode routine — mirrors the chat-mode toggles
 * (chat-input.tsx). Loop, subagents, orchestration and plan do not exist there.
 */
export const ROUTINE_CHAT_MODES: (keyof Omit<RoutineModes, 'permissionMode'>)[] = [
  'search',
  'browser',
  'simple',
  'brain',
  'vision',
]

/**
 * A routine's mode follows its folders: with at least one it runs as code, without any it runs
 * as a chat. The person never picks a mode — they attach folders, or not.
 */
export function routineModeFor(folders: readonly string[]): 'chat' | 'code' {
  return folders.length > 0 ? 'code' : 'chat'
}

/** The modes a chat routine can keep: the code-only ones are dropped, the permission stays. */
export function restrictModesToChat(modes: RoutineModes): RoutineModes {
  const out: RoutineModes = { permissionMode: modes.permissionMode }
  for (const key of ROUTINE_CHAT_MODES) if (modes[key]) out[key] = true
  return out
}

/** Permission modes offered to a routine, in the order they are displayed. */
export const ROUTINE_PERMISSIONS: PermissionMode[] = ['approve', 'full', 'ask']

export const DEFAULT_ROUTINE_PERMISSION: PermissionMode = 'approve'

/** Modes → chat options. Mirrors the rules of the `chat:send` handler. */
export function routineOptions(modes: RoutineModes): SendMessageOptions {
  const options: SendMessageOptions = {
    // "Autonomy" runs on its own and only stops on a critical action. When it
    // stops, the request shows up in that execution's chat and the session gets
    // the "waiting for an answer" dot in the sidebar — that is how the routine
    // tells the user.
    permissionMode: modes.permissionMode ?? DEFAULT_ROUTINE_PERMISSION,
  }
  if (modes.brain) options.brain = true
  if (modes.browser) options.browser = true
  if (modes.simple) options.simple = true
  if (modes.search) options.research = true
  // vision does not go into the options: it is the scheduler's input.visionModel
  // (the routine stores its own vision model, just as it stores the main one).
  if (modes.orchestrate) {
    // Orchestration turns plan off and loop/subagents on, as in chat:send
    options.orchestrate = {}
    options.loop = modes.loop !== false
    options.subagents = modes.subagents !== false
    return options
  }
  if (modes.loop) options.loop = true
  if (modes.subagents) options.subagents = true
  if (modes.plan) options.plan = true
  return options
}

// ─── Routine ─────────────────────────────────────────────────────────────────

export interface RoutineModel {
  providerId: string
  modelId: string
}

export interface Routine {
  id: string
  title: string
  /** Self-contained prompt sent on every execution */
  prompt: string
  schedule: Schedule
  model: RoutineModel
  modes: RoutineModes
  /**
   * Routine mode: 'code' runs inside the working folders; 'chat' runs without
   * folders, with the modes restricted to the chat subset.
   */
  mode: 'chat' | 'code'
  /** Working folders, inherited from the workspace at creation time (code only) */
  folders: string[]
  /**
   * Vision model stored at creation time when the Vision mode is on — the
   * main process does not read the renderer's localStorage, so the routine is
   * self-contained.
   */
  visionModel?: RoutineModel
  /**
   * Keep every execution in ONE chat instead of opening a new chat per firing.
   * Absent/false = the original behaviour (a session per execution).
   */
  reuseChat?: boolean
  /**
   * The chat the next execution continues (only with `reuseChat`). Written by
   * the scheduler; when the session is gone or archived the next execution
   * opens a fresh one and updates this field.
   */
  chatSessionId?: string
  active: boolean
  createdAt: number
  lastRun?: number
}

/** Creation/edit input (the id and createdAt belong to the main process). */
export interface NewRoutineInput {
  title: string
  prompt: string
  schedule: Schedule
  model: RoutineModel
  modes: RoutineModes
  /** Absent = 'code' (older routines and external callers) */
  mode?: 'chat' | 'code'
  folders: string[]
  visionModel?: RoutineModel
  reuseChat?: boolean
  active?: boolean
  /**
   * Only whoever already has an identity of its own passes it: the proposal
   * approved in the conversation card creates the routine with the SAME id
   * (that is what lets the card recognise it).
   */
  id?: string
}

/**
 * Routine proposal made by the agent (tool routines_manage): it stays in
 * staging until the person approves it in the card. It is not a Routine — it
 * has no createdAt or lastRun, and it only exists while unapproved.
 */
export interface PendingRoutine {
  /** Id of the proposal AND of the routine it becomes on approval. */
  id: string
  title: string
  prompt: string
  schedule: Schedule
  modes: RoutineModes
  mode: 'chat' | 'code'
  folders: string[]
  model: RoutineModel
  visionModel?: RoutineModel
  createdAt: number
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export type RoutineRunStatus = 'running' | 'ok' | 'error'

/**
 * Metrics of ONE execution, keyed by sessionId. The list shown in the panel is
 * DERIVED from the sessions (`sessions.filter(s => s.routineId === id)`):
 * deleting the chat in the sidebar makes the run disappear on its own, with no
 * "deleted" state dangling.
 */
export interface RoutineRun {
  routineId: string
  sessionId: string
  startedAt: number
  completedAt?: number
  status: RoutineRunStatus
  error?: string
  tokens: number
  cost: number
}

// ─── Generation (user prompt → proposed routine) ─────────────────────────────

/** Output of step 1 → 2: the model proposes, the user confirms in the review. */
export interface RoutineSuggestion {
  title: string
  prompt: string
  schedule: Schedule
  modes: RoutineModes
}

export type GenerationResult =
  | { ok: true; suggestion: RoutineSuggestion }
  | { ok: false; error: string }

// ─── Events (main → renderer) ────────────────────────────────────────────────

export type RoutineEvent =
  | { type: 'routines'; routines: Routine[] }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine-removed'; id: string }
  | { type: 'run'; run: RoutineRun }

// ─── Next firing computation ─────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

/** "09:00" → { hour: 9, minute: 0 }. Returns null on an invalid time. */
export function parseTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function withTime(base: Date, hour: number, minute: number): number {
  const d = new Date(base)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

/** "YYYY-MM-DD" → local Date at midnight. Null when invalid. */
function parseOnceDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const d = new Date(year, month - 1, day)
  // Rejects dates that Date "fixes up" (Feb 31 → Mar 3).
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return d
}

/**
 * Next execution instant STRICTLY after `after`.
 *
 * `lastRun` only matters for `intervalDays` (the count starts from it); on
 * weekday schedules the calendar already defines everything.
 *
 * Returns null when the schedule is invalid — the routine does not fire instead
 * of firing at a guessed time.
 */
export function nextRun(schedule: Schedule, after: number, lastRun?: number): number | null {
  const hm = parseTime(schedule.time)
  if (!hm) return null
  const { hour, minute } = hm
  const base = new Date(after)

  if (schedule.onceDate) {
    const date = parseOnceDate(schedule.onceDate)
    if (!date) return null
    const target = withTime(date, hour, minute)
    // There is only ONE firing: once the date has passed the routine never runs
    // again — the scheduler turns it off when the execution completes (see
    // runRoutine).
    return target > after ? target : null
  }

  if (schedule.intervalHours && schedule.intervalHours > 0) {
    const step = Math.floor(schedule.intervalHours) * 60 * 60 * 1000
    // With a previous run the count starts from it (every N hours for real);
    // without one, the first firing lands on today's `time` — a grid anchored
    // on the time of day.
    const anchor = lastRun ?? withTime(base, hour, minute)
    let target = anchor
    if (target <= after) {
      const jumps = Math.ceil((after - target) / step)
      target += Math.max(jumps, 1) * step
      while (target <= after) target += step
    }
    return target
  }

  if (schedule.intervalDays && schedule.intervalDays > 0) {
    const step = Math.floor(schedule.intervalDays)
    // The advance is in CALENDAR DAYS, not in multiples of 24h: adding
    // milliseconds crosses a daylight-saving change and the 09:00 routine ends
    // up running at 08:00 (or 10:00) forever.
    const anchor = new Date(lastRun ?? after)
    const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    // Without a previous run the first firing lands on the next available time.
    if (lastRun) day.setDate(day.getDate() + step)
    let target = withTime(day, hour, minute)
    if (target <= after) {
      // O(1) jump: stepping by `step` in an app closed for months would cost
      // thousands of iterations on every scheduler tick. The loop afterwards
      // only fixes the edge (one or two rounds at most).
      const jumps = Math.ceil((Math.floor((after - target) / DAY_MS) + 1) / step)
      day.setDate(day.getDate() + jumps * step)
      target = withTime(day, hour, minute)
      while (target <= after) {
        day.setDate(day.getDate() + step)
        target = withTime(day, hour, minute)
      }
    }
    return target
  }

  const days = schedule.days?.length ? new Set(schedule.days) : null
  // 8 attempts cover the whole week plus "today is already past the time".
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    if (days && !days.has(day.getDay())) continue
    const target = withTime(day, hour, minute)
    if (target > after) return target
  }
  return null
}

/** Next run of an active routine (null when it is off or the schedule is invalid). */
export function nextRoutineRun(routine: Routine, now = Date.now()): number | null {
  if (!routine.active) return null
  return nextRun(routine.schedule, now, routine.lastRun)
}

/**
 * Every firing of a routine inside `[from, until)`, in order — what the agenda draws and the
 * "next 24 hours" list reads. It walks `nextRun` one step at a time, so it follows exactly the
 * rules the scheduler uses (weekdays, every N days or hours, one-time).
 *
 * An inactive routine returns nothing, unless `includeInactive` asks for what it WOULD do
 * (the agenda shows paused routines as outlines). `limit` is the net against a schedule that
 * fires every hour over a long window.
 */
export function upcomingRuns(
  routine: Routine,
  from: number,
  until: number,
  options: { limit?: number; includeInactive?: boolean } = {},
): number[] {
  if (!routine.active && !options.includeInactive) return []
  const limit = options.limit ?? 200
  const out: number[] = []
  let cursor = from - 1
  while (out.length < limit) {
    const target = nextRun(routine.schedule, cursor, routine.lastRun)
    if (target === null || target >= until) break
    out.push(target)
    cursor = target
  }
  return out
}
