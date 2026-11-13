import { streamText } from 'ai'
import type { GenerationResult, RoutineModel, RoutineModes, RoutineSuggestion, Schedule } from '@shared/routines'
import { DEFAULT_ROUTINE_PERMISSION, parseTime } from '@shared/routines'
import { getProvider } from '../catalog'
import { resolveModel } from '../providers'
import { interleavedReasoningField, normalizeMessages } from '../reasoning'

/**
 * Step 1 → 2 of creating a routine: the user describes what they want in plain
 * prose and the model returns the title, the refined prompt, the schedule and
 * the suggested modes.
 *
 * It runs headless (no chat session, no tools), like the pipeline runner: the
 * cycle here is one question and one JSON answer, not a conversation. The user
 * confirms everything in the review screen — nothing that comes out of here goes
 * straight to disk.
 *
 * Every routine works inside a folder of its own (memory.md, scripts/) and may also be given
 * working folders — projects the prompt sends it to. The system prompt describes both.
 */

const SYSTEM = `You design scheduled routines for Orbit: a routine is a prompt that an autonomous agent runs by itself, on a schedule.

Every routine has a folder of its own — memory.md and scripts/ live there, and so does whatever it produces. It may also be given WORKING FOLDERS: projects it may read and edit when the prompt sends it there. Scripts and documents it creates belong in its own folder unless the user explicitly asks for them in a working folder.

From the user's description, produce ONE routine.

Rules:
- The prompt must be SELF-CONTAINED: the agent that runs it has no memory of this conversation and no one to ask. State the goal, the folders/files involved when known, what to inspect, and what a finished run looks like.
- Write title and prompt in the SAME LANGUAGE as the user's description (a Portuguese description yields a Portuguese prompt — never switch to English unless asked).
- The routine's result is a chat message the user reads: by default the prompt just answers in the chat. It may write scripts and documents inside its own folder, but it must NOT create, modify or delete anything in the working folders — and must not commit or install anything — unless the user's description EXPLICITLY asks it to (e.g. "save to the project", "write a JSON there"). If the goal is delivering information — a greeting, the news, a summary — deliver it as plain text in the reply.
- "Create tasks" is NOT a request to persist to disk. See the PIPELINE section below.
- The routine runs unattended: never ask the user questions in the prompt, never require an approval step.
- schedule.time is "HH:MM" (24h, local time). schedule.days is 0-6 with 0 = Sunday; omit days for every day. Use intervalDays only for "every N days" and intervalHours only for "every N hours" (one cadence, never two). For a one-time request ("once on DATE", "tomorrow at 9", "remind me on the 5th"), set onceDate as "YYYY-MM-DD" plus time — the routine turns itself off after that single run.
- If the user gave no time, pick a sensible one and say so in the title context, not in the prompt.

PIPELINE = ORBIT'S TASK BOARD, never a file:
- In Orbit, "pipeline", "pipeline mode" and "board mode" all name the SAME feature: a board of phases (e.g. development → validation → code review → security → infra) where every task is a board item that agents pick up and run autonomously. The user may use any of these words, in any language.
- When the description asks to create/open/add tasks, or to work "in pipeline mode", the routine must create BOARD TASKS through the pipeline tools: pipeline_list to find the board, then pipeline_create_task once per unit of work, each with a title and a self-contained description (goal, files involved, acceptance criteria).
- Writing a markdown or JSON file (PIPELINE.md, TASKS.md, a checklist on disk) is NOT creating tasks and must never be the routine's output for these requests. The board is the destination; the repository is only read.
- Say all of this explicitly in the prompt you write, naming the pipeline tools — the agent that runs the routine later has no access to this instruction and must not have to guess.
- Only treat "pipeline" as something else (CI/CD, a data pipeline) when the description makes that unmistakable, e.g. it names GitHub Actions, a YAML workflow or an ETL job.

- Suggest modes conservatively, based on the work:
  - loop: multi-step work that benefits from reviewing its own output before stopping.
  - subagents: work that splits into independent parallel investigations.
  - orchestrate: only for large tasks that need a plan and several workers; it implies loop + subagents.
  - brain: the routine should remember previous runs (daily reports, follow-ups, anything cumulative).
  - browser: the routine has to look at a running web UI.
  - search: the routine needs up-to-date web research (deep research with search tools).
  - vision: the routine inspects images/screenshots — only when a vision model is available.
  - plan and simple: leave false unless the user clearly asked for a plan-only or plain-text routine.

Answer with JSON ONLY — no prose, no markdown fences:
{"title":"...","prompt":"...","schedule":{"time":"09:00","days":[1,2,3,4,5]},"modes":{"loop":true,"subagents":false,"orchestrate":false,"brain":true,"browser":false,"search":false,"vision":false,"plan":false,"simple":false}}`

const MAX_OUTPUT = 20_000

/** Extracts the JSON object from the reply (models insist on fences or prose). */
function extractJson(text: string): unknown {
  const withoutFence = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(withoutFence.slice(start, end + 1))
  } catch {
    return null
  }
}

function normalizeSchedule(raw: unknown): Schedule {
  const obj = (raw ?? {}) as Record<string, unknown>
  const time = typeof obj.time === 'string' && parseTime(obj.time) ? obj.time.trim() : '09:00'
  const schedule: Schedule = { time }
  if (Array.isArray(obj.days)) {
    const days = [...new Set(obj.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    // 7 days marked = "every day": storing the full list would only make the UI
    // show seven chips where one sentence fits.
    if (days.length > 0 && days.length < 7) schedule.days = days
  }
  // Newer cadences: "every N hours" and "once". The precedence mirrors the
  // computation (nextRun): onceDate > intervalHours > intervalDays.
  const once =
    typeof obj.onceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.onceDate.trim())
      ? obj.onceDate.trim()
      : null
  if (once) return { time, onceDate: once }
  const intervalHours = Number(obj.intervalHours)
  if (
    Number.isInteger(intervalHours) &&
    intervalHours >= 1 &&
    intervalHours <= 23 &&
    !schedule.days &&
    !schedule.intervalDays
  ) {
    schedule.intervalHours = intervalHours
  }
  const interval = Number(obj.intervalDays)
  if (Number.isInteger(interval) && interval > 1 && !schedule.days && !schedule.intervalHours) {
    schedule.intervalDays = interval
  }
  return schedule
}

function normalizeModes(raw: unknown, visionAvailable: boolean): RoutineModes {
  const obj = (raw ?? {}) as Record<string, unknown>
  const bool = (key: string) => obj[key] === true
  const modes: RoutineModes = { permissionMode: DEFAULT_ROUTINE_PERMISSION }
  if (bool('loop')) modes.loop = true
  if (bool('subagents')) modes.subagents = true
  if (bool('orchestrate')) modes.orchestrate = true
  if (bool('brain')) modes.brain = true
  if (bool('browser')) modes.browser = true
  if (bool('simple')) modes.simple = true
  if (bool('search')) modes.search = true
  if (bool('vision') && visionAvailable) modes.vision = true
  // Plan is incompatible with running unattended (it would sit around waiting
  // for approval) and with orchestration — the generator must not turn it on by
  // accident.
  if (bool('plan') && !modes.orchestrate) modes.plan = true
  return modes
}

export async function generateRoutine(
  description: string,
  model: RoutineModel,
  folders: string[],
  language?: string,
  visionAvailable = true,
): Promise<GenerationResult> {
  const text = description.trim()
  if (!text) return { ok: false, error: 'Describe the routine before generating.' }

  const provider = await getProvider(model.providerId)
  const context = [
    folders.length
      ? `Working folders: ${folders.join(', ')}`
      : 'Working folders: (none — the routine works only in its own folder)',
    language ? `User language: ${language}` : null,
    `Today: ${new Date().toISOString().slice(0, 10)} (${new Date().toLocaleDateString('en-US', { weekday: 'long' })})`,
  ]
    .filter(Boolean)
    .join('\n')

  let output = ''
  try {
    const resolved = await resolveModel(model.providerId, model.modelId)
    const stream = streamText({
      model: resolved,
      system: SYSTEM,
      messages: normalizeMessages(
        [{ role: 'user', content: `${context}\n\n## Routine described by the user\n${text}` }],
        interleavedReasoningField(provider, model.modelId),
      ),
      onError: () => {
        /* handled below by the accumulated error */
      },
    })
    for await (const part of stream.fullStream) {
      if (part.type === 'text-delta') {
        output += part.text
        if (output.length > MAX_OUTPUT) break
      } else if (part.type === 'error') {
        const detail = part.error instanceof Error ? part.error.message : String(part.error)
        return { ok: false, error: detail }
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const raw = extractJson(output) as Record<string, unknown> | null
  if (!raw) {
    return { ok: false, error: 'The model did not return valid JSON. Try again or switch models.' }
  }

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) return { ok: false, error: 'The model response came without the routine prompt.' }

  const suggestion: RoutineSuggestion = {
    title: (typeof raw.title === 'string' && raw.title.trim()) || text.slice(0, 60),
    prompt,
    schedule: normalizeSchedule(raw.schedule),
    modes: normalizeModes(raw.modes, visionAvailable),
  }
  return { ok: true, suggestion }
}
