import { tool } from 'ai'
import { ASK_WHEN_VAGUE } from './proposal-guidance'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import type { PendingRoutine, RoutineModes, Schedule } from '@shared/routines'
import { nextRoutineRun, parseTime } from '@shared/routines'
import { removeRoutineCompletely, runNow, updateRoutineFields } from '../routines'
import { listRoutines } from '../routines/repo'
import { listPendingRoutines, newProposalId, proposeRoutine } from '../routines/pending'
import { cleanHosts, describeOutcome, newScriptId, saveScriptFromAgent, validScriptName } from '../routines/scripts/manage'
import { runScript } from '../routines/scripts/runner'
import { MAX_SCRIPT_EVERY_MINUTES, MIN_SCRIPT_EVERY_MINUTES, type RoutineScript, type RoutineTrigger } from '@shared/routines'

/**
 * Tool routines_manage: the agent schedules from the chat. The "create" action
 * does NOT write straight away: it stages a proposal (routine-proposals) and a
 * confirmation card shows up in the conversation — the person is the one who
 * really creates it, in the card (the same rule as the modal's generator:
 * nothing goes to disk without review). The other actions (list, run, pause,
 * resume, remove) are immediate, like the same actions in the routines panel.
 */

const scheduleSchema = z.object({
  time: z.string().regex(/^\d{1,2}:\d{2}$/).describe('"HH:MM" (24h, local time)'),
  days: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional()
    .describe('Weekdays (0 = Sunday). Omit for every day.'),
  intervalDays: z.number().int().min(2).max(365).optional().describe('Alternative to days: every N days.'),
  intervalHours: z.number().int().min(1).max(23).optional().describe('Alternative to days: every N hours.'),
  onceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('One-time routine: "YYYY-MM-DD". Turns itself off after that single run.'),
})

const modesSchema = z.object({
  loop: z.boolean().optional(),
  subagents: z.boolean().optional(),
  orchestrate: z.boolean().optional(),
  brain: z.boolean().optional(),
  simple: z.boolean().optional(),
  plan: z.boolean().optional(),
  browser: z.boolean().optional(),
  search: z.boolean().optional(),
  vision: z.boolean().optional(),
  permissionMode: z.enum(['ask', 'approve', 'full']).optional(),
})

const scriptSchema = z.object({
  name: z.string().describe('How the agent of the routine calls it: lower case letters, digits, underscores (for example "read_report_template").'),
  summary: z.string().describe('One sentence for the person: what the script does.'),
  code: z
    .string()
    .describe(
      'Body of an async function (JavaScript). Available: input; await fetch(url) -> {ok,status,text(),json()} (https GET, declared hosts only); ' +
        'await readFile(path), await readSheet(path, sheet?) -> {rows,sheets}, await listFiles(dir) (inside the routine folders, only if readFiles); ' +
        'state.get(key)/state.set(key,value) to remember between runs; seen(id) -> true if already handled (and remembers it); fire(payload) wakes the routine (trigger scripts); log(...). Return a JSON value.',
    ),
  hosts: z.array(z.string()).max(10).describe('Domains the script may fetch over https, for example ["api.github.com"]. Empty if it fetches nothing.'),
  readFiles: z.boolean().optional().describe('True if the script reads files or spreadsheets in the routine folders.'),
})

/** Short schedule sentence, for the texts returned to the model. */
function summarizeSchedule(schedule: Schedule): string {
  if (schedule.onceDate) return `${schedule.onceDate} ${schedule.time} (once)`
  if (schedule.intervalHours) return `every ${schedule.intervalHours}h`
  if (schedule.intervalDays) return `every ${schedule.intervalDays} days at ${schedule.time}`
  if (schedule.days?.length) return `at ${schedule.time} on days ${schedule.days.join(',')}`
  return `every day at ${schedule.time}`
}

/** Normalizes the model's schedule: one cadence only, in the precedence of the computation. */
function normalizeSchedule(schedule: Schedule): Schedule {
  if (schedule.onceDate) return { time: schedule.time, onceDate: schedule.onceDate }
  if (schedule.intervalHours) {
    return { time: schedule.time, intervalHours: Math.max(1, Math.min(23, Math.floor(schedule.intervalHours))) }
  }
  if (schedule.intervalDays) {
    return { time: schedule.time, intervalDays: Math.max(2, Math.min(365, Math.floor(schedule.intervalDays))) }
  }
  if (schedule.days?.length) {
    const days = [...new Set(schedule.days)].sort((a, b) => a - b)
    // 7 days = "every day": the UI prefers the short sentence to seven chips.
    return days.length === 7 ? { time: schedule.time } : { time: schedule.time, days }
  }
  return { time: schedule.time }
}

/** Modes respecting the routine's mode (chat has no loop/orchestration/plan). */
function normalizeModes(modes: RoutineModes, mode: 'chat' | 'code', hasVision: boolean): RoutineModes {
  const base: RoutineModes = { permissionMode: modes.permissionMode ?? 'approve' }
  if (mode === 'chat') {
    if (modes.brain) base.brain = true
    if (modes.browser) base.browser = true
    if (modes.simple) base.simple = true
    if (modes.search) base.search = true
    if (modes.vision && hasVision) base.vision = true
    return base
  }
  if (modes.loop) base.loop = true
  if (modes.subagents) base.subagents = true
  if (modes.orchestrate) {
    // Orchestration implies loop + subagents — the same rule as the generator.
    base.orchestrate = true
    base.loop = true
    base.subagents = true
  }
  if (modes.brain) base.brain = true
  if (modes.browser) base.browser = true
  if (modes.simple) base.simple = true
  if (modes.search) base.search = true
  if (modes.vision && hasVision) base.vision = true
  // Plan sits around waiting for approval — incompatible with running unattended.
  if (modes.plan && !base.orchestrate) base.plan = true
  return base
}

export function createRoutinesTool(input: SendMessageInput) {
  return tool({
    description:
      'Manages Orbit routines: chats that run by themselves, in chat or code mode, woken by a schedule, by a script or by an incoming webhook request. A routine can carry scripts: small programs that read a spreadsheet, call an API or watch for something. A script can be called by the routine\'s agent (run_script) or be the routine\'s trigger (it checks every N minutes and calls fire() to wake the routine, so the agent only runs when something happens). A webhook routine ("webhook" in "create") runs when something calls its local address: Orbit only listens on this computer while it is open, and the person exposes it with their own tunnel if the sender is on the internet. Scripts need the person\'s approval before they run, and they only work while Orbit is open. Write a script, try it with "test_script" until it works, then include it in "create"; "save_script" adds or changes a script of an existing routine (it then waits for approval). Actions: "list" lists existing routines; "create" proposes a new routine (it shows a confirmation card in the conversation — the routine is only created when the user approves it in the card); "run" runs a routine immediately; "pause"/"resume" pause/resume it; "remove" deletes it. For "create": list first to avoid duplicates, write a self-contained prompt (the agent that runs it later has no memory of this conversation), keep the schedule exactly as the user asked (intervalHours for "every N hours", onceDate for a one-time request), and suggest modes conservatively. After "create", briefly explain what was proposed. ' + ASK_WHEN_VAGUE,
    inputSchema: z.object({
      action: z.enum(['list', 'create', 'run', 'pause', 'resume', 'remove', 'test_script', 'save_script']).describe('The action to perform.'),
      routineId: z.string().optional().describe('Routine id (from "list"). Required for run/pause/resume/remove.'),
      title: z.string().optional().describe('Routine title (action "create").'),
      prompt: z.string().optional().describe('Self-contained prompt that runs at every execution (action "create").'),
      schedule: scheduleSchema.optional().describe('Schedule (action "create").'),
      modes: modesSchema.optional().describe('Modes (action "create"). Omit for safe defaults (approve, no extra modes).'),
      scripts: z.array(scriptSchema).max(6).optional().describe('Scripts attached to the new routine (action "create").'),
      trigger: z
        .object({
          script: z.string().describe('Name of one of the scripts above: it decides when the routine runs.'),
          everyMinutes: z.number().int().min(MIN_SCRIPT_EVERY_MINUTES).max(MAX_SCRIPT_EVERY_MINUTES).describe('How often the script checks.'),
        })
        .optional()
        .describe('Wake the routine from a script instead of the schedule (action "create"). The schedule is then ignored.'),
      webhook: z
        .object({ signed: z.boolean().optional().describe('True to also require an HMAC-SHA256 signature made with a secret Orbit generates.') })
        .optional()
        .describe(
          'Wake the routine when something sends it an HTTP request (action "create"; alternative to schedule and trigger). Orbit listens only on this computer (127.0.0.1) while it is open; reaching it from the internet is the person\'s own tunnel. The body of each request reaches the agent as data.',
        ),
      script: scriptSchema.optional().describe('One script, for the actions "test_script" and "save_script".'),
    }),
    execute: async ({ action, routineId, title, prompt, schedule, modes, scripts, trigger, webhook, script }) => {
      const mode: 'chat' | 'code' = input.mode === 'chat' ? 'chat' : 'code'
      const folders = [input.directory, ...(input.extraDirectories ?? [])].filter((p): p is string => Boolean(p))
      const model = { providerId: input.providerId, modelId: input.modelId }

      if (action === 'list') {
        const routines = await listRoutines()
        if (routines.length === 0) return 'No routine exists yet.'
        return routines
          .map((r) => {
            const next = nextRoutineRun(r)
            const when = next ? new Date(next).toLocaleString('en-US') : ''
            return `- ${r.title} (id: ${r.id}) — ${r.mode}, ${summarizeSchedule(r.schedule)}, ${r.active ? 'active' : 'paused'}${when ? `, next run: ${when}` : ''}`
          })
          .join('\n')
      }

      if (action === 'test_script') {
        if (!script) return 'Provide the script to test.'
        if (script.readFiles && folders.length === 0) return 'This conversation has no folder, so a script cannot read files.'
        const outcome = await runScript({
          script: { code: script.code, hosts: cleanHosts(script.hosts), readFiles: script.readFiles },
          folders,
        })
        // A test never keeps the script's memory and never wakes the routine.
        return describeOutcome(outcome)
      }

      if (action === 'create') {
        if (!title?.trim() || !prompt?.trim()) return 'To create a routine, provide title and prompt.'
        const triggerOf = (built: RoutineScript[]): RoutineTrigger | string | undefined => {
          if (!trigger) return undefined
          const target = built.find((s) => s.name === trigger.script)
          return target ? { kind: 'script', scriptId: target.id, everyMinutes: trigger.everyMinutes } : `The trigger names "${trigger.script}", which is not among the scripts.`
        }
        const built: RoutineScript[] = []
        for (const s of scripts ?? []) {
          if (!validScriptName(s.name)) return `Invalid script name "${s.name}": use lower case letters, digits and underscores.`
          if (s.readFiles && (mode === 'chat' || folders.length === 0)) return 'A script can only read files in a routine that has a folder.'
          built.push({ id: newScriptId(), name: s.name, summary: s.summary.trim(), code: s.code, hosts: cleanHosts(s.hosts), readFiles: s.readFiles || undefined })
        }
        if (trigger && webhook) return 'A routine has one trigger: use either "trigger" (a script) or "webhook", not both.'
        const resolvedTrigger = webhook ? ({ kind: 'webhook', ...(webhook.signed ? { signed: true } : {}) } satisfies RoutineTrigger) : triggerOf(built)
        if (typeof resolvedTrigger === 'string') return resolvedTrigger
        // A script- or webhook-triggered routine has no calendar: the schedule below is only a placeholder.
        if (!resolvedTrigger && (!schedule || !parseTime(schedule.time))) return 'The schedule needs a valid "HH:MM" time.'
        if (mode === 'code' && folders.length === 0) {
          return 'In code mode the routine needs a working folder, and this conversation has none open.'
        }
        const proposal: PendingRoutine = {
          id: newProposalId(),
          title: title.trim(),
          prompt: prompt.trim(),
          schedule: normalizeSchedule(resolvedTrigger ? { time: '00:00' } : schedule!),
          ...(built.length > 0 ? { scripts: built } : {}),
          ...(resolvedTrigger ? { trigger: resolvedTrigger } : {}),
          modes: normalizeModes(modes ?? {}, mode, Boolean(input.visionModel)),
          mode,
          folders: mode === 'chat' ? [] : folders,
          model,
          visionModel: modes?.vision && input.visionModel ? input.visionModel : undefined,
          createdAt: Date.now(),
        }
        await proposeRoutine(proposal)
        const pending = (await listPendingRoutines()).length
        return (
          `Routine proposal created (id: ${proposal.id}) — waiting for approval in the conversation card (${pending} pending). ` +
          'The routine is only created when the user clicks "Create routine" in the card. ' +
          'Now explain, in 1-2 sentences, what the routine does and when it runs.'
        )
      }

      if (!routineId) return 'Provide routineId (use "list" to find the id).'
      const routine = (await listRoutines()).find((r) => r.id === routineId)
      if (!routine) return `Routine ${routineId} not found.`

      if (action === 'save_script') {
        if (!script) return 'Provide the script to save.'
        if (script.readFiles && routine.folders.length === 0) return 'This routine has no folder, so a script cannot read files.'
        const saved = await saveScriptFromAgent(routineId, { ...script })
        if (!saved.ok) return saved.error
        return `Script "${script.name}" saved on "${routine.title}". It is NOT approved yet and cannot run: tell the person to open the routine and approve it (they see exactly what it does first).`
      }

      if (action === 'run') {
        const sessionId = await runNow(routineId)
        return sessionId
          ? `Execution fired in session ${sessionId}. Its chat shows up in the "Routines" group of the sidebar.`
          : `Routine "${routine.title}" is already running or could not run now (no working folder).`
      }
      if (action === 'pause' || action === 'resume') {
        const active = action === 'resume'
        await updateRoutineFields(routineId, { active })
        return `Routine "${routine.title}" ${active ? 'resumed' : 'paused'}.`
      }
      await removeRoutineCompletely(routineId)
      return `Routine "${routine.title}" removed. The chats of past executions stay in the sidebar and can be deleted by hand.`
    },
  })
}
