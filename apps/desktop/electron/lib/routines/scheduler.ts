import path from 'node:path'
import { BrowserWindow, Notification } from 'electron'
import type { ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { Routine, RoutineEvent, RoutineRun } from '@shared/routines'
import { hasTeam, isScriptTriggered, nextRun, routineOptions, ROUTINE_SESSION_PREFIX } from '@shared/routines'
import { continuationBrief, getRunningSessionIds, runChat } from '../chat-engine'
import { runChatWithLoop } from '../loop-engine'
import { runOrchestration, runTeam } from '../orchestrator'
import { broadcastChatEvent, broadcastRoutineEvent } from '../broadcast'
import { dataDir, readJson, writeJson } from '../storage'
import { readAppLanguage } from '../app-language'
import { t } from '../i18n'
import { listRoutines, listRuns, saveRun, updateRoutine } from './repo'
import { createRunFolder } from './run-folder'
import { promptWithEvents } from './scripts/event-prompt'
import { superviseScripts, type SupervisorDeps } from './scripts/supervisor'

/**
 * Routines scheduler: a one-minute tick in the main process, no cron library.
 *
 * The trigger REUSES the `chat:send` path (runChat / runChatWithLoop /
 * runOrchestration) instead of having its own runner like the pipeline. The
 * pipeline is not a conversation — a routine is: it needs history, per-message
 * diff, permissions and the chat UI that already exist.
 *
 * Known limitation: with the app CLOSED nothing runs — the scheduler dies with
 * the main process. On reopening, a late execution inside the tolerance window
 * still fires; anything older is dropped (the 09:00 routine must not run at
 * 23:00 three days later).
 */

const TICK_INTERVAL_MS = 60_000
/** Maximum delay tolerated on firing (app closed, machine suspended). */
const LATE_WINDOW_MS = 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Routines running right now. A routine never fires again while the previous
 * execution has not finished — same rule as the pipeline's `running` map: the
 * second run would work over the files the first one is touching.
 */
const running = new Set<string>()

export function emit(event: RoutineEvent): void {
  broadcastRoutineEvent(event)
}

// ─── Execution session ───────────────────────────────────────────────────────

function stamp(when: number): string {
  const d = new Date(when)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Every execution is born in a session of its own — that is what gives the
 * routine its chat history. `folderId` stays null on purpose: routine chats
 * live only in the "Routines" group of the sidebar, never inside a folder. The
 * session inherits the routine's mode: that is what makes the sidebar separate
 * chat routines from code routines.
 */
async function createSession(routine: Routine, when: number, scratch?: string): Promise<SessionInfo> {
  // A team with no folder of its own works in the scratch folder of the run, so it is code.
  const chat = routine.mode === 'chat' && !scratch
  const session: SessionInfo = {
    id: `${ROUTINE_SESSION_PREFIX}${routine.id}_${when.toString(36)}`,
    // A reused chat holds many executions, so a timestamp in the title would be a
    // lie after the first one: it carries only the routine's name.
    title: routine.reuseChat ? routine.title : `${routine.title} — ${stamp(when)}`,
    mode: chat ? 'chat' : 'code',
    pinned: false,
    archived: false,
    folderId: null,
    directory: scratch ?? (chat ? undefined : routine.folders[0]),
    extraDirectories: chat ? undefined : routine.folders.slice(1),
    routineId: routine.id,
    createdAt: when,
    updatedAt: when,
  }
  await writeJson(StorageKeys.session(session.id), session)
  // The renderer only knows the session through this event: it was born in the
  // main process, outside the session-store. Without it the routine's chat does
  // not show up in the sidebar until a reload.
  broadcastChatEvent({ type: 'session', sessionId: session.id, session })
  return session
}

/**
 * Metrics of what the execution consumed: sums the assistant turns.
 *
 * `since` keeps a reused chat honest: its history holds every previous
 * execution, and counting those would charge each run for all the ones before it.
 */
async function collectResult(
  sessionId: string,
  since = 0,
): Promise<{ tokens: number; cost: number; error?: string }> {
  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  let tokens = 0
  let cost = 0
  let error: string | undefined
  for (const msg of messages) {
    if (msg.role !== 'assistant' || msg.createdAt < since) continue
    if (msg.tokens) {
      tokens += msg.tokens.input + msg.tokens.output + msg.tokens.reasoning
      cost += msg.tokens.cost ?? 0
    }
    // The LAST turn's error wins: a failure in the middle that the loop worked
    // around does not turn the whole execution into a failure.
    error = msg.error
  }
  return { tokens, cost, error }
}

async function notify(routine: Routine, run: RoutineRun): Promise<void> {
  if (!Notification.isSupported()) return
  const ok = run.status === 'ok'
  // Body in a fixed translated sentence (the title is the routine name, user
  // data); the execution error is provider/engine text — never translated.
  const body = ok
    ? run.cost > 0
      ? await t('notif.routine.doneWithCost', { cost: run.cost.toFixed(4) })
      : await t('notif.routine.done')
    : await t('notif.routine.failed', {
        error: (run.error ?? '').slice(0, 120) || (await t('notif.routine.unknownError')),
      })
  new Notification({ title: routine.title, body, silent: ok }).show()
}

// ─── Reused chat ─────────────────────────────────────────────────────────────

/**
 * The chat a reusing routine continues, or null when there is none to continue:
 * never created, deleted, or archived (archiving is how the person closes a chat
 * that got too long — the next execution starts a fresh one).
 */
async function findReusableSession(routine: Routine): Promise<SessionInfo | null> {
  if (!routine.reuseChat || !routine.chatSessionId) return null
  const session = await readJson<SessionInfo>(StorageKeys.session(routine.chatSessionId))
  if (!session || session.archived) return null
  return session
}

/** Rebinds the routine to the chat its next execution will continue. */
async function bindChat(routine: Routine, sessionId: string): Promise<void> {
  const updated = await updateRoutine(routine.id, (r) => ({ ...r, chatSessionId: sessionId }))
  if (updated) emit({ type: 'routine', routine: updated })
}

/**
 * "New chat for this routine": opens the next chat, carries a brief of the old one
 * over (the same continuation brief the compaction card uses, so the routine does
 * not start from zero) and archives the old chat. Returns the new session id.
 *
 * The new chat is created BEFORE the old one is archived: if anything fails in
 * between, the routine still has a chat to continue.
 */
export async function rotateChat(routineId: string): Promise<string | null> {
  const routine = (await listRoutines()).find((r) => r.id === routineId)
  if (!routine || !routine.reuseChat) return null
  const previousId = routine.chatSessionId
  // A turn in the old chat would be writing to a history we are about to leave.
  if (previousId && getRunningSessionIds().includes(previousId)) return null

  const fresh = await createSession(routine, Date.now())
  if (previousId) {
    const brief = await continuationBrief(previousId).catch(() => null)
    if (brief) {
      const seed: ChatMessage = {
        id: `${fresh.id}_brief`,
        role: 'assistant',
        summary: true,
        // The brief that opened the chat, not a compaction of it (the UI labels it so).
        continuation: true,
        parts: [{ id: `${fresh.id}_brief_text`, type: 'text', text: brief.text, state: 'done' }],
        createdAt: fresh.createdAt,
      }
      await writeJson(StorageKeys.messages(fresh.id), [seed])
    }
  }
  await bindChat(routine, fresh.id)

  if (previousId) {
    const previous = await readJson<SessionInfo>(StorageKeys.session(previousId))
    if (previous && !previous.archived) {
      const archived: SessionInfo = { ...previous, archived: true, archivedAt: Date.now() }
      await writeJson(StorageKeys.session(previousId), archived)
      broadcastChatEvent({ type: 'session', sessionId: previousId, session: archived })
    }
  }
  return fresh.id
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Runs the routine now. Returns the created sessionId, or null when the routine
 * is already running or has no working folder.
 */
export async function runRoutine(
  routine: Routine,
  reason: 'schedule' | 'manual' | 'event',
  /** What the trigger script found (reason 'event'). */
  events: readonly string[] = [],
): Promise<string | null> {
  if (running.has(routine.id)) return null
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return null
  // A working folder is only required in code mode: the chat routine runs
  // without a project, using only the chat-mode tools.
  if (routine.mode !== 'chat' && !routine.folders[0]) {
    console.warn(`[routines] "${routine.title}" has no working folder — execution skipped`)
    return null
  }

  const reusable = await findReusableSession(routine)
  // The person is talking in the routine's chat: firing now would start a second
  // turn over the same history. Skip this firing; the next tick tries again.
  if (reusable && getRunningSessionIds().includes(reusable.id)) {
    console.warn(`[routines] "${routine.title}" skipped — its chat is busy`)
    return null
  }

  running.add(routine.id)
  const start = Date.now()
  // A team has to write somewhere: with no folder of its own it gets one for this run only,
  // kept afterwards (the run row opens it).
  const scratch = hasTeam(routine) && !routine.folders[0] ? await createRunFolder(path.join(dataDir(), 'routine-runs'), routine.id, start).catch(() => undefined) : undefined
  const session = reusable ?? (await createSession(routine, start, scratch))
  if (routine.reuseChat && session.id !== routine.chatSessionId) await bindChat(routine, session.id)

  let run: RoutineRun = {
    routineId: routine.id,
    sessionId: session.id,
    startedAt: start,
    status: 'running',
    ...(scratch ? { folder: scratch } : {}),
    tokens: 0,
    cost: 0,
  }
  await saveRun(run)
  emit({ type: 'run', run })

  // `lastRun` is stamped BEFORE running: if it were left to the end, a long turn
  // would make the next tick believe the routine had not run yet.
  const updated = await updateRoutine(routine.id, (r) => ({ ...r, lastRun: start }))
  if (updated) emit({ type: 'routine', routine: updated })

  // A team makes the routine an orchestration whatever its modes say: the members are the plan.
  const team = hasTeam(routine) ? routine.team : undefined
  const options = routineOptions(team ? { ...routine.modes, orchestrate: true } : routine.modes, {
    tokenBudget: routine.tokenBudget,
    maxParallel: team?.maxParallel,
    review: routine.review,
  })
  // A chat routine only knows the chat modes: not even a hand-edited
  // routines.json should be able to turn orchestration/loop/subagents/plan on in
  // a mode that does not support them (the orchestrator, for instance, pins
  // worker sessions to mode 'code' — orchestration simply does not run in chat).
  if (routine.mode === 'chat' && !scratch) {
    options.orchestrate = undefined
    options.loop = undefined
    options.subagents = undefined
    options.plan = undefined
  }
  const language = await readAppLanguage()
  const input: SendMessageInput = {
    sessionId: session.id,
    text: promptWithEvents(routine.prompt, events),
    providerId: routine.model.providerId,
    modelId: routine.model.modelId,
    mode: scratch ? 'code' : session.mode,
    options,
    ...(routine.scripts?.length ? { routineContext: { id: routine.id, folders: routine.folders, scripts: routine.scripts } } : {}),
    directory: scratch ?? session.directory,
    extraDirectories: session.extraDirectories,
    // Subagents/orchestration need a worker model; the routine uses its own,
    // which is the only model it knows.
    ...(options.subagents || options.orchestrate ? { workerModel: routine.model } : {}),
    // Vision mode: the routine carries the vision model it had at creation time
    // (the main process does not read the renderer's localStorage).
    ...(routine.modes.vision && routine.visionModel ? { visionModel: routine.visionModel } : {}),
    // Read NOW, not stored in the routine: changing the app language immediately
    // applies to routines that already exist. Without this the agent falls back
    // to "answer in the user's language" and follows the PROMPT's language —
    // English in the sample routines.
    ...(language ? { language } : {}),
    ...(options.loop ? { loopConfig: { maxIterations: 5 } } : {}),
  }

  console.log(`[routines] firing "${routine.title}" (${reason}) in session ${session.id}`)

  try {
    if (options.orchestrate && team) await runTeam(win, input, team, { scratch: !!scratch })
    else if (options.orchestrate) await runOrchestration(win, input)
    else if (options.loop) await runChatWithLoop(win, input, input.loopConfig!)
    else await runChat(win, input)
    const { tokens, cost, error } = await collectResult(session.id, start)
    run = { ...run, completedAt: Date.now(), status: error ? 'error' : 'ok', error, tokens, cost }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const { tokens, cost } = await collectResult(session.id, start)
    run = { ...run, completedAt: Date.now(), status: 'error', error: detail, tokens, cost }
  } finally {
    running.delete(routine.id)
  }

  // The routine may have been deleted in the middle of the execution (the delete
  // erases the chats and aborts the stream). Writing the metrics again would
  // resurrect an orphan record in runs.json — better to end quietly.
  const stillExists = (await listRoutines()).some((r) => r.id === routine.id)
  if (!stillExists) return session.id

  await saveRun(run)
  emit({ type: 'run', run })
  void notify(routine, run)

  // One-time schedule: after running, the routine turns itself off. The
  // computation would no longer return it (the target is in the past), but the
  // switch in the UI would say otherwise — turning it off here closes the loop
  // in the right place.
  if (routine.schedule.onceDate) {
    const deactivated = await updateRoutine(routine.id, (r) => ({ ...r, active: false }))
    if (deactivated) emit({ type: 'routine', routine: deactivated })
  }
  return session.id
}

/** "Run now" of the panel — same execution, without touching the schedule. */
export async function runNow(id: string): Promise<string | null> {
  const routine = (await listRoutines()).find((r) => r.id === id)
  if (!routine) return null
  return runRoutine(routine, 'manual')
}

// ─── Tick ────────────────────────────────────────────────────────────────────

const supervisorDeps: SupervisorDeps = {
  startRun: (routine, payloads) => runRoutine(routine, 'event', payloads),
  isRunning: (routineId) => running.has(routineId),
  onActivity: (activity) => emit({ type: 'script-activity', activity }),
  onFailing: (routine, error) => {
    if (!Notification.isSupported()) return
    void t('notif.routine.scriptFailing', { error: error.slice(0, 120) }).then((body) =>
      new Notification({ title: routine.title, body }).show(),
    )
  },
}

async function tick(): Promise<void> {
  const now = Date.now()
  let routines: Routine[]
  try {
    routines = await listRoutines()
  } catch (err) {
    console.error('[routines] could not read the routines on tick:', err)
    return
  }

  void superviseScripts(routines, supervisorDeps).catch((err) => console.error('[routines] script supervision failed:', err))

  for (const routine of routines) {
    // A script decides when these run (superviseScripts above), not the calendar.
    if (!routine.active || running.has(routine.id) || isScriptTriggered(routine)) continue
    // The floor drops the missed windows at once: with the app closed for days,
    // the routine goes back to the calendar on the next time of day instead of
    // trying to recover every firing that did not happen.
    const base = Math.max(routine.lastRun ?? routine.createdAt, now - LATE_WINDOW_MS)
    const target = nextRun(routine.schedule, base, routine.lastRun)
    // Invalid schedule (a time that does not parse): the routine stays put
    // instead of firing at a guessed time.
    if (target == null || target > now) continue

    // No await: a long routine must not hold back the others in this tick.
    void runRoutine(routine, 'schedule').catch((err) =>
      console.error(`[routines] run of "${routine.title}" failed:`, err),
    )
  }
}

/**
 * Runs marked "running" on disk with nobody executing them: the app was closed
 * (or crashed) in the middle. Closing the record on boot avoids an endless
 * spinner in the panel and a routine that never fires again.
 */
async function reconcileRuns(): Promise<void> {
  for (const run of await listRuns()) {
    if (run.status !== 'running' || running.has(run.routineId)) continue
    const closed: RoutineRun = {
      ...run,
      status: 'error',
      completedAt: Date.now(),
      error: run.error ?? 'Execution interrupted (app closed).',
    }
    await saveRun(closed)
    emit({ type: 'run', run: closed })
  }
}

export function startScheduler(): void {
  if (timer) return
  void reconcileRuns().catch((err) => console.error('[routines] reconciliation failed:', err))
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS)
  // An immediate tick catches what came due while the app was closed (inside the
  // tolerance window) without waiting for the first minute.
  void tick()
}

export function stopScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
