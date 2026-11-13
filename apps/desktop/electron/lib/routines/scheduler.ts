import path from 'node:path'
import { BrowserWindow, Notification } from 'electron'
import type { ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { Routine, RoutineEvent, RoutineRun, WebhookActivity } from '@shared/routines'
import { listAgentsSync, loadAgents } from '../agents/store'
import { userProfileId } from '@shared/agents'
import { applyAgentModes, hasTeam, isEventTriggered, nextRun, routineOptions, ROUTINE_SESSION_PREFIX } from '@shared/routines'
import { runChat } from '../chat-engine'
import { runChatWithLoop } from '../loop-engine'
import { runOrchestration, runTeam } from '../orchestrator'
import { broadcastChatEvent, broadcastRoutineEvent } from '../broadcast'
import { readJson, writeJson } from '../storage'
import { readAppLanguage } from '../app-language'
import { t } from '../i18n'
import { listRoutines, listRuns, saveRun, updateRoutine } from './repo'
import { appendRunCard, ensureRoutineChat, finishRunCard } from './chat-session'
import { ensureRoutineFolder, readMemory } from './folder'
import { promptWithEvents } from './scripts/event-prompt'
import { superviseScripts, type SupervisorDeps } from './scripts/supervisor'
import { stopWebhooks, tickWebhooks } from './webhooks/service'

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
 * Every execution is born in a session of its own, CHILD of the routine's chat: the run is
 * detail, not a conversation of its own. `folderId` stays null on purpose: routine chats
 * live only in the "Routines" group of the sidebar, never inside a folder.
 *
 * The execution works INSIDE the routine's own folder; the working folders ride along as
 * extra directories — projects the prompt points the agent at.
 */
async function createSession(routine: Routine, when: number, folder: string, parentId?: string): Promise<SessionInfo> {
  const session: SessionInfo = {
    id: `${ROUTINE_SESSION_PREFIX}${routine.id}_${when.toString(36)}`,
    title: `${routine.title} — ${stamp(when)}`,
    mode: 'code',
    pinned: false,
    archived: false,
    folderId: null,
    directory: folder,
    ...(routine.folders.length > 0 ? { extraDirectories: [...routine.folders] } : {}),
    routineId: routine.id,
    ...(parentId ? { parentId } : {}),
    // A routine run by an agent opens its chats as that agent's chats.
    ...(routine.agent ? { profile: routine.agent } : {}),
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
  // The title says WHERE it came from and names the routine: a banner from a routine must
  // be told apart from one from a fragment (or from a message in a chat).
  const origin = await t('notif.routine.title')
  new Notification({ title: `${origin} · ${routine.title}`, body, silent: ok }).show()
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Runs the routine now. Returns the created sessionId, or null when the routine
 * is already running or its folder cannot be created.
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

  running.add(routine.id)
  const start = Date.now()
  // The routine's own folder is where the execution lives: created here the first time it is
  // needed, since not every routine writes anything.
  let routineFolder = routine.folder
  if (!routineFolder) {
    routineFolder = await ensureRoutineFolder(routine).catch(() => undefined)
    if (routineFolder) {
      const saved = await updateRoutine(routine.id, (r) => ({ ...r, folder: routineFolder }))
      if (saved) emit({ type: 'routine', routine: saved })
    }
  }
  if (!routineFolder) {
    console.warn(`[routines] "${routine.title}" — could not create its folder, execution skipped`)
    running.delete(routine.id)
    return null
  }
  const memory = (await readMemory(routineFolder)).trim()
  // The routine's own chat exists before the execution: the run is written INTO it as a card,
  // and the execution's session is born as its child.
  const chat = await ensureRoutineChat(routine, routineFolder)
  const session = await createSession(routine, start, routineFolder, chat.id)

  let run: RoutineRun = {
    routineId: routine.id,
    sessionId: session.id,
    startedAt: start,
    status: 'running',
    reason,
    tokens: 0,
    cost: 0,
  }
  await saveRun(run)
  emit({ type: 'run', run })
  // The card is born with the run, so the chat shows "running" while it works.
  await appendRunCard(chat.id, {
    run,
    agents: routine.team?.members.map((member) => member.name) ?? [],
    reason,
  }).catch((err) => console.error('[routines] could not write the run card:', err))

  // `lastRun` is stamped BEFORE running: if it were left to the end, a long turn
  // would make the next tick believe the routine had not run yet.
  const updated = await updateRoutine(routine.id, (r) => ({ ...r, lastRun: start }))
  if (updated) emit({ type: 'routine', routine: updated })

  // The agent that does the work decides which abilities are on (vision, sub-agents, orchestra,
  // loop, memories); read now, so editing the agent changes its routines too.
  await loadAgents()
  const agent = routine.agent ? listAgentsSync().find((a) => userProfileId(a.id) === routine.agent) : undefined
  const modes = agent ? applyAgentModes(routine.modes, agent.features) : routine.modes
  // A team makes the routine an orchestration whatever its modes say: the members are the plan.
  const team = hasTeam(routine) ? routine.team : undefined
  const options = routineOptions(team ? { ...modes, orchestrate: true } : modes, {
    tokenBudget: routine.tokenBudget,
    maxParallel: team?.maxParallel,
    review: routine.review,
  })
  const memoryBlock = memory ? `\n\n## Memória da rotina (memory.md)\n${memory}` : ''
  // The routine's folder is its home: memory and scripts live there, and so does whatever it
  // produces unless the prompt sends it to a working folder.
  const folderBlock =
    `\n\n## Pasta da rotina\nA sua pasta é ${routineFolder}. É onde ficam a memória (${path.join(routineFolder, 'memory.md')}) e os scripts (${path.join(routineFolder, 'scripts')}). Escreva nela os scripts e documentos que você criar, a menos que o pedido mande gravá-los em uma pasta de trabalho.` +
    (routine.folders.length > 0
      ? `\nAs pastas de trabalho desta rotina — para ler e editar conforme o pedido: ${routine.folders.join(', ')}.`
      : '') +
    '\nAo terminar, registre no memory.md o que precisar lembrar na próxima execução; se não houver nada, deixe o arquivo como está.'
  const language = await readAppLanguage()
  const input: SendMessageInput = {
    sessionId: session.id,
    text: promptWithEvents(routine.prompt, events) + memoryBlock + folderBlock,
    providerId: routine.model.providerId,
    modelId: routine.model.modelId,
    mode: session.mode,
    options,
    ...(routine.scripts?.length
      ? { routineContext: { id: routine.id, folder: routineFolder, folders: routine.folders, scripts: routine.scripts } }
      : {}),
    directory: session.directory,
    extraDirectories: session.extraDirectories,
    // Subagents/orchestration need a worker model; the routine uses its own,
    // which is the only model it knows.
    ...(options.subagents || options.orchestrate ? { workerModel: routine.model } : {}),
    // Vision mode: the routine carries the vision model it had at creation time
    // (the main process does not read the renderer's localStorage).
    ...(modes.vision && routine.visionModel ? { visionModel: routine.visionModel } : {}),
    // Read NOW, not stored in the routine: changing the app language immediately
    // applies to routines that already exist. Without this the agent falls back
    // to "answer in the user's language" and follows the PROMPT's language —
    // English in the sample routines.
    ...(language ? { language } : {}),
    ...(options.loop ? { loopConfig: { maxIterations: 5 } } : {}),
  }

  console.log(`[routines] firing "${routine.title}" (${reason}) in session ${session.id}`)

  try {
    // The routine's folder is the team's shared working place: members leave their full
    // result there as a file, not only in the summary the next member reads.
    if (options.orchestrate && team) await runTeam(win, input, team, { handoff: true })
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
  // Closes the card with what the execution delivered (or with the failure).
  await finishRunCard(chat.id, run).catch((err) => console.error('[routines] could not close the run card:', err))
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

const webhookDeps = {
  startRun: supervisorDeps.startRun,
  isRunning: supervisorDeps.isRunning,
  onActivity: (activity: WebhookActivity) => emit({ type: 'webhook-activity', activity }),
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

  void tickWebhooks(routines, webhookDeps).catch((err) => console.error('[routines] webhook supervision failed:', err))

  for (const routine of routines) {
    // A script or a webhook decides when these run (above), not the calendar.
    if (!routine.active || running.has(routine.id) || isEventTriggered(routine)) continue
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
  stopWebhooks()
}
