/**
 * Routines — chats that come back on their own.
 *
 * A routine is a prompt + a schedule. At the appointed time the main-process
 * scheduler creates a fresh chat session and dispatches it through the SAME
 * `chat:send` path (runChat / runChatWithLoop / runOrchestration): loop,
 * orchestration, per-message diff, permissions and the existing chat UI all
 * come for free.
 *
 * Every execution is a session of its own (`routine_<id>_<ts>`, carrying
 * `routineId`), never one conversation that keeps growing: that is what makes the run
 * history on the routine screen and the individual deletion from the sidebar possible.
 * "Remembering the previous day" is the Brain's job, enabled through the routine's modes.
 *
 * Every routine owns a folder of its own — memory.md, scripts/ and whatever it produces —
 * and runs inside it. The `folders` are the EXTRA folders the prompt points it at: projects
 * it may read and edit, never where it keeps its own things.
 */

import type { AgentFeature } from './agents'
import type { PermissionMode, ProfileId, SendMessageOptions } from './chat'

/** Prefix of the session ids created by a routine. */
export const ROUTINE_SESSION_PREFIX = 'routine_'

/**
 * Prefix used before the domain was renamed to English. Sessions written back
 * then keep it, so anything that RECOGNISES a routine session must accept
 * both; only creation uses the new one.
 */
export const LEGACY_ROUTINE_SESSION_PREFIX = 'rotina_'

/** True when the session id was minted by a routine run (current or legacy prefix). */
/**
 * Id of the routine's main chat. No timestamp on purpose: the executions are the ones that
 * are born per run (children of this one); the conversation is the routine's, always the same.
 */
export function routineChatSessionId(routineId: string): string {
  return `${ROUTINE_SESSION_PREFIX}${routineId}`
}

/** Message of one execution inside the routine's chat — the anchor the panel jumps to. */
export function routineRunMessageId(sessionId: string): string {
  return `run_card_${sessionId}`
}

export function isRoutineSessionId(id: string): boolean {
  return id.startsWith(ROUTINE_SESSION_PREFIX) || id.startsWith(LEGACY_ROUTINE_SESSION_PREFIX)
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
 * What an agent lets a routine do. An agent's features say what it does NOT block, so a routine run
 * by an agent gets exactly those abilities: the routine has no ability switches of its own on top.
 * (Memories are the Brain mode, orchestra is orchestration.) Abilities the agent never governs
 * (web, browser, simple, plan) are left to the routine's own modes.
 */
export function modesFromAgentFeatures(features: Record<AgentFeature, boolean>): RoutineModes {
  return {
    ...(features.vision ? { vision: true } : {}),
    ...(features.subagents ? { subagents: true } : {}),
    ...(features.orchestra ? { orchestrate: true } : {}),
    ...(features.loop ? { loop: true } : {}),
    ...(features.memories ? { brain: true } : {}),
  }
}

const AGENT_GOVERNED: (keyof Omit<RoutineModes, 'permissionMode'>)[] = ['vision', 'subagents', 'orchestrate', 'loop', 'brain']

/** The routine's modes with the ones an agent governs replaced by what that agent allows. */
export function applyAgentModes(modes: RoutineModes, features: Record<AgentFeature, boolean>): RoutineModes {
  const allowed = modesFromAgentFeatures(features)
  const out: RoutineModes = { ...modes }
  for (const key of AGENT_GOVERNED) out[key] = allowed[key]
  return out
}

/** Permission modes offered to a routine, in the order they are displayed. */
export const ROUTINE_PERMISSIONS: PermissionMode[] = ['approve', 'full', 'ask']

export const DEFAULT_ROUTINE_PERMISSION: PermissionMode = 'approve'

/** Modes → chat options. Mirrors the rules of the `chat:send` handler. */
export function routineOptions(modes: RoutineModes, limits: RoutineLimits = {}): SendMessageOptions {
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
    // A routine has nobody to click "Approve": the team starts on its own, inside its limits.
    options.orchestrate = {
      unattended: {
        ...(limits.tokenBudget ? { tokenBudget: limits.tokenBudget } : {}),
        ...(limits.maxParallel ? { maxParallel: limits.maxParallel } : {}),
        ...(limits.review ? { review: true } : {}),
      },
    }
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

/** Limits of a routine that runs a team unattended. */
export interface RoutineLimits {
  /** Tokens the whole team may spend in one execution; absent = no ceiling. */
  tokenBudget?: number
  /** Members working at the same time; absent = the engine's default. */
  maxParallel?: number
  /** The model reviews each member's work (costs more, catches more); absent = no review. */
  review?: boolean
}

// ─── Scripts ─────────────────────────────────────────────────────────────────

/**
 * A script attached to a routine: a small program that runs in the background of Orbit, with only
 * the abilities it declares. It is generic on purpose — the same script can be the routine's
 * trigger (it watches something and wakes the agent) or a tool the agent calls during a run (read
 * the report template from a spreadsheet, fetch a number from an API). Written by an agent, so it
 * never runs before the person approved exactly this code with exactly these abilities.
 */
export interface RoutineScript {
  id: string
  /** How the agent calls it ("read_report_template"). */
  name: string
  /** One sentence for the person (and the agent): what it does. */
  summary: string
  /** Body of an async function; see the script API in electron/lib/routines/scripts. */
  code: string
  /** Hosts the script may fetch over https (a subdomain of a listed host is allowed too). */
  hosts: string[]
  /** May read files and spreadsheets inside the routine's folders (read-only). */
  readFiles?: boolean
  /**
   * Names of stored secrets the script may use (`fetch(url, { auth: { secret } })`). The value
   * never reaches the script: the main process adds it to the request, to declared hosts only.
   */
  secrets?: string[]
  /**
   * SQLite files (paths inside the routine folders) the script may query, read-only, with
   * `db.query`. Anything else it asks for is refused.
   */
  databases?: string[]
  /** The fingerprint of the version the person approved; absent = never approved. */
  approvedFingerprint?: string
}

/** Everything that decides what a script can do and does, as one comparable string. */
export function scriptFingerprint(script: Pick<RoutineScript, 'code' | 'hosts' | 'readFiles' | 'secrets' | 'databases'>): string {
  const base: unknown[] = [script.code, [...script.hosts].sort(), !!script.readFiles]
  // Optional abilities go in ONE tagged object, only when present: scripts approved before they
  // existed stay approved, and a secret named X can never look like a database named X.
  const extras: Record<string, string[]> = {}
  if (script.secrets?.length) extras.secrets = [...script.secrets].sort()
  if (script.databases?.length) extras.databases = [...script.databases].sort()
  if (Object.keys(extras).length > 0) base.push(extras)
  return JSON.stringify(base)
}

/** A secret name: upper case letters, digits and underscores ("GITHUB_TOKEN"). */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/

/** Is this exact version (code and abilities) the one the person approved? */
export function scriptApproved(script: RoutineScript): boolean {
  return script.approvedFingerprint === scriptFingerprint(script)
}

/**
 * What wakes the routine. `schedule` (the default) is the routine's days and times; `script`
 * runs one of the routine's scripts every few minutes, and the routine runs when the script fires.
 */
export type RoutineTrigger =
  | { kind: 'schedule' }
  | { kind: 'script'; scriptId: string; everyMinutes: number }
  /**
   * An HTTP request to a private local address wakes the routine. `signed` also demands a valid
   * HMAC signature made with the routine's own secret.
   */
  | { kind: 'webhook'; signed?: boolean }

export const MIN_SCRIPT_EVERY_MINUTES = 1
export const MAX_SCRIPT_EVERY_MINUTES = 24 * 60

/** The script that triggers the routine, when it has one that exists. */
export function triggerScript(routine: Pick<Routine, 'trigger' | 'scripts'>): RoutineScript | undefined {
  const trigger = routine.trigger
  if (trigger?.kind !== 'script') return undefined
  return routine.scripts?.find((s) => s.id === trigger.scriptId)
}

/** Does a script, not the calendar, decide when this routine runs? */
export function isScriptTriggered(routine: Pick<Routine, 'trigger'>): boolean {
  return routine.trigger?.kind === 'script'
}

/** Does a webhook call decide when this routine runs? */
export function isWebhookTriggered(routine: Pick<Routine, 'trigger'>): boolean {
  return routine.trigger?.kind === 'webhook'
}

/** Does something other than the calendar (a script or a webhook) decide when this routine runs? */
export function isEventTriggered(routine: Pick<Routine, 'trigger'>): boolean {
  return isScriptTriggered(routine) || isWebhookTriggered(routine)
}

/** One agent of a routine's team and what it must do. */
export interface TeamMember {
  /** Stable inside the team: the other members point at it in `dependsOn`. */
  id: string
  /** What the member is called in the run ("Scriptwriter"). */
  name: string
  /** Self-contained instruction for this member. */
  task: string
  /** The agent that runs it (`agent:<id>` or a built-in); absent = the general setup. */
  agent?: ProfileId
  /** The model this member runs on; absent = the routine's model. */
  model?: RoutineModel
  /** Members that must finish first; their result reaches this one. */
  dependsOn?: string[]
}

/** A routine's own team: runs unattended, in the order the dependencies say. */
export interface RoutineTeam {
  members: TeamMember[]
  /** Members working at the same time; absent = the engine's default. */
  maxParallel?: number
}

/** Does this routine run a team of its own (as opposed to a single agent)? */
export function hasTeam(routine: { team?: RoutineTeam }): boolean {
  return (routine.team?.members.length ?? 0) > 0
}

export interface RoutineModel {
  providerId: string
  modelId: string
}

/** Roots a routine's scripts may read: its own folder first, then the working folders. */
export function scriptRoots(folder: string | undefined, folders: readonly string[]): string[] {
  return folder ? [folder, ...folders] : [...folders]
}

export interface Routine {
  id: string
  title: string
  /** Self-contained prompt sent on every execution */
  prompt: string
  schedule: Schedule
  model: RoutineModel
  modes: RoutineModes
  /** Folders the prompt hands to the agent: projects it may read and edit. Absent = only its own folder. */
  folders: string[]
  /** Absolute path of the routine's own folder (memory.md, scripts) — created with it. */
  folder?: string
  /**
   * Vision model stored at creation time when the Vision mode is on — the
   * main process does not read the renderer's localStorage, so the routine is
   * self-contained.
   */
  visionModel?: RoutineModel
  /** The agent (`agent:<id>`) that does the work; absent = the general setup. Its features decide the abilities. */
  agent?: ProfileId
  /** Ceiling of a team's execution (only matters with the orchestrate mode). */
  tokenBudget?: number
  /** A team's work is reviewed by the model (the global supervise setting); absent = unattended runs skip the review. */
  review?: boolean
  /** The routine's own team; absent = a single agent does the work. */
  team?: RoutineTeam
  /** Scripts attached to the routine (see RoutineScript). */
  scripts?: RoutineScript[]
  /** What wakes the routine; absent = its schedule. */
  trigger?: RoutineTrigger
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
  folders: string[]
  visionModel?: RoutineModel
  agent?: ProfileId
  tokenBudget?: number
  review?: boolean
  team?: RoutineTeam
  scripts?: RoutineScript[]
  trigger?: RoutineTrigger
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
  agent?: ProfileId
  team?: RoutineTeam
  tokenBudget?: number
  scripts?: RoutineScript[]
  trigger?: RoutineTrigger
  /** Id of the proposal AND of the routine it becomes on approval. */
  id: string
  title: string
  prompt: string
  schedule: Schedule
  modes: RoutineModes
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
  /** How it started: the clock, the button, or the trigger (`event`). */
  reason?: 'schedule' | 'manual' | 'event'
  error?: string
  /** Scratch folder of a team that had no folder of its own: kept after the run, so the files can be opened. */
  folder?: string
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

/** What a manual test run of a script returns to the screen (nothing was kept or fired). */
export type ScriptTestResult =
  | { ok: true; result: unknown; fires: string[]; logs: string[] }
  | { ok: false; error: string; logs: string[] }

// ─── Script activity ─────────────────────────────────────────────────────────

/** One check of a trigger script. */
export interface ScriptCheck {
  at: number
  ok: boolean
  /** How many times the script woke the routine in this check. */
  fired: number
  error?: string
  logs?: string[]
}

/** What the person sees of a script-triggered routine: the recent checks and its health. */
export interface ScriptActivity {
  routineId: string
  /** Newest last, capped. */
  checks: ScriptCheck[]
  /** Consecutive failed checks; the routine says "failing" from {@link SCRIPT_FAILING_AFTER}. */
  failures: number
  /** The earliest the next check may run (backoff after failures). */
  nextCheckAt: number
  lastFireAt?: number
  /** Payloads the script fired that no execution has picked up yet (the routine was busy). */
  pending: string[]
}

export const SCRIPT_FAILING_AFTER = 3
/** The script cannot wake the routine more often than this: a broken script must not loop the agent. */
export const MIN_FIRE_GAP_MS = 5 * 60 * 1000
export const MAX_SCRIPT_CHECKS_KEPT = 288

// ─── Webhook activity ────────────────────────────────────────────────────────

/** One call that reached a routine's webhook address. */
export interface WebhookDelivery {
  at: number
  accepted: boolean
  /** Why it was refused (never the content of the call). */
  error?: string
  /** Size of the body that was read. */
  bytes: number
}

/** What the person sees of a webhook-triggered routine: the latest calls and what waits for a run. */
export interface WebhookActivity {
  routineId: string
  /** Newest last, capped. */
  deliveries: WebhookDelivery[]
  lastFireAt?: number
  /** Accepted payloads no execution has picked up yet (the routine was busy, or the fire gap). */
  pending: string[]
}

/** What the routine screen needs to show the address of a webhook. */
export interface WebhookInfo {
  /** The listener is up; false = the app is not receiving (routine paused or listener failed). */
  listening: boolean
  /** Local address that receives the calls; absent while not listening. */
  url?: string
  /** Secret the sender signs the body with (only when the routine requires a signature). */
  secret?: string
  activity: WebhookActivity
}

export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024
/** The payload the agent reads is cut to this many characters. */
export const WEBHOOK_MAX_PAYLOAD_CHARS = 8000
export const MAX_WEBHOOK_DELIVERIES_KEPT = 50

// ─── Events (main → renderer) ──────────────────────────────────────────────── ────────────────────────────────────────────────

export type RoutineEvent =
  | { type: 'routines'; routines: Routine[] }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine-removed'; id: string }
  | { type: 'run'; run: RoutineRun }
  | { type: 'script-activity'; activity: ScriptActivity }
  | { type: 'webhook-activity'; activity: WebhookActivity }

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
  // A script or a webhook decides when it runs, not the calendar.
  if (!routine.active || isEventTriggered(routine)) return null
  return nextRun(routine.schedule, now, routine.lastRun)
}

/**
 * A one-off whose moment has already passed: it is FINISHED, not paused — the scheduler turns it
 * off after the run, and turning it back on has to choose a new date. Telling the two apart keeps
 * the list from calling "paused" something the person never paused.
 */
export function isFinishedOnce(routine: Routine, now = Date.now()): boolean {
  const { onceDate, time } = routine.schedule
  if (!onceDate) return false
  const hm = parseTime(time)
  if (!hm) return false
  const date = new Date(`${onceDate}T00:00:00`)
  if (Number.isNaN(date.getTime())) return false
  date.setHours(hm.hour, hm.minute, 0, 0)
  return date.getTime() <= now
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
  // A script decides when it runs: there is no calendar to draw.
  if (isEventTriggered(routine) || (!routine.active && !options.includeInactive)) return []
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
