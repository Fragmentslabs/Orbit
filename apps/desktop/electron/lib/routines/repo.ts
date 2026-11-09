import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  PendingRoutine,
  Routine,
  RoutineModes,
  RoutineModel,
  RoutineRun,
  Schedule,
} from '@shared/routines'

/**
 * Routines persistence: JSON in the app data folder, mirroring pipeline mode
 * (electron/lib/pipeline/repo.ts).
 *
 *   orbit-data/routines/routines.json
 *   orbit-data/routines/runs.json
 *
 * Atomic writes (tmp + rename) and one serial queue per file: the scheduler
 * writes the result of an execution while the UI may be saving the edit of
 * another routine, and two concurrent writes would lose one of the versions.
 *
 * `LEGACY_*` names the layout written before the domain was renamed to English.
 * It is only read once, by `migrateLegacyData`, so that existing installs keep
 * their routines, their run metrics and their pending proposals.
 */

const DATA_DIR = 'routines'
const ROUTINES = 'routines.json'
const RUNS = 'runs.json'

const LEGACY_DIR = 'rotinas'
const LEGACY_ROUTINES = 'rotinas.json'

/** Staging folder of the agent proposals (see pending.ts). */
const PROPOSALS_DIR = 'routine-proposals'
const LEGACY_PROPOSALS_DIR = 'rotinas-pending'

function dataRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data')
}

function baseDir(): string {
  return path.join(dataRoot(), DATA_DIR)
}

/** Where each script-triggered routine keeps its script state and its check log. */
export function scriptsDir(): string {
  return path.join(baseDir(), 'scripts')
}

export function proposalsDir(): string {
  return path.join(dataRoot(), PROPOSALS_DIR)
}

// ─── Legacy migration (one-shot, idempotent) ─────────────────────────────────

type Json = Record<string, unknown>

/** First value found among the current key and the legacy one. */
function pick<T>(raw: Json, next: string, legacy: string): T | undefined {
  return (raw[next] ?? raw[legacy]) as T | undefined
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** Maps a persisted enum value from the legacy vocabulary to the current one. */
function legacyValue<T extends string>(value: unknown, map: Record<string, string>): T | undefined {
  if (value == null) return undefined
  const key = String(value)
  return (map[key] ?? key) as T
}

const RUN_STATUS: Record<string, string> = { rodando: 'running', erro: 'error' }

function mapSchedule(raw: Json): Schedule {
  return {
    time: pick<string>(raw, 'time', 'horario') ?? '',
    ...(pick(raw, 'days', 'dias') !== undefined ? { days: asArray<number>(pick(raw, 'days', 'dias')) } : {}),
    ...(pick(raw, 'intervalDays', 'intervaloDias') !== undefined
      ? { intervalDays: Number(pick(raw, 'intervalDays', 'intervaloDias')) }
      : {}),
    ...(pick(raw, 'intervalHours', 'intervaloHoras') !== undefined
      ? { intervalHours: Number(pick(raw, 'intervalHours', 'intervaloHoras')) }
      : {}),
    ...(pick(raw, 'onceDate', 'umaVezData') !== undefined
      ? { onceDate: String(pick(raw, 'onceDate', 'umaVezData')) }
      : {}),
  }
}

/** Mode keys never changed; only the container field did (agenda → schedule). */
function mapModes(raw: Json | undefined): RoutineModes {
  return (raw ?? {}) as RoutineModes
}

function mapModel(raw: Json | undefined): RoutineModel {
  return { providerId: String(raw?.providerId ?? ''), modelId: String(raw?.modelId ?? '') }
}

function mapRoutine(raw: Json): Routine {
  return {
    id: String(raw.id),
    title: pick<string>(raw, 'title', 'titulo') ?? '',
    prompt: (raw.prompt as string) ?? '',
    schedule: mapSchedule((pick<Json>(raw, 'schedule', 'agenda') ?? {}) as Json),
    model: mapModel(pick<Json>(raw, 'model', 'modelo')),
    modes: mapModes(pick<Json>(raw, 'modes', 'modos')),
    // Routines created before the explicit `mode` field are code routines.
    mode: (raw.mode as Routine['mode'] | undefined) ?? 'code',
    folders: asArray<string>(pick(raw, 'folders', 'pastas')),
    ...(raw.visionModel !== undefined ? { visionModel: mapModel(raw.visionModel as Json) } : {}),
    active: Boolean(pick<boolean>(raw, 'active', 'ativa') ?? true),
    createdAt: Number(pick<number>(raw, 'createdAt', 'criadoEm') ?? 0),
    ...(pick(raw, 'lastRun', 'ultimaExecucao') !== undefined
      ? { lastRun: Number(pick(raw, 'lastRun', 'ultimaExecucao')) }
      : {}),
  }
}

function mapRun(raw: Json): RoutineRun {
  return {
    routineId: String(pick(raw, 'routineId', 'rotinaId')),
    sessionId: String(raw.sessionId),
    startedAt: Number(pick<number>(raw, 'startedAt', 'iniciadoEm') ?? 0),
    ...(pick(raw, 'completedAt', 'concluidoEm') !== undefined
      ? { completedAt: Number(pick(raw, 'completedAt', 'concluidoEm')) }
      : {}),
    status: legacyValue<RoutineRun['status']>(raw.status, RUN_STATUS) ?? 'ok',
    ...(pick(raw, 'error', 'erro') !== undefined ? { error: String(pick(raw, 'error', 'erro')) } : {}),
    tokens: Number(raw.tokens ?? 0),
    cost: Number(pick<number>(raw, 'cost', 'custo') ?? 0),
  }
}

function mapProposal(raw: Json): PendingRoutine {
  return {
    id: String(raw.id),
    title: pick<string>(raw, 'title', 'titulo') ?? '',
    prompt: (raw.prompt as string) ?? '',
    schedule: mapSchedule((pick<Json>(raw, 'schedule', 'agenda') ?? {}) as Json),
    modes: mapModes(pick<Json>(raw, 'modes', 'modos')),
    mode: (raw.mode as PendingRoutine['mode'] | undefined) ?? 'code',
    folders: asArray<string>(pick(raw, 'folders', 'pastas')),
    model: mapModel(pick<Json>(raw, 'model', 'modelo')),
    ...(raw.visionModel !== undefined ? { visionModel: mapModel(raw.visionModel as Json) } : {}),
    createdAt: Number(pick<number>(raw, 'createdAt', 'criadoEm') ?? 0),
  }
}

async function exists(file: string): Promise<boolean> {
  return Boolean(await fsp.stat(file).catch(() => undefined))
}

/** Reads one JSON file, returning undefined when it is missing or corrupted. */
async function readJsonFile(file: string): Promise<unknown> {
  const raw = await fsp.readFile(file, 'utf8').catch(() => undefined)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined // corrupted file: leave it alone, the UI restarts from the empty state
  }
}

/** Serialized write (tmp + rename), used by the migration only. */
async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/**
 * Copies one legacy JSON file to its current name, mapping keys and enum
 * values, and only when the current file does not exist yet. The legacy file
 * is left untouched: it is the user's data, and a migration that only reads
 * has nothing to lose if it runs twice.
 */
async function migrateFile(
  legacy: string,
  current: string,
  map: (raw: Json) => unknown,
): Promise<boolean> {
  if (!(await exists(legacy)) || (await exists(current))) return false
  const parsed = await readJsonFile(legacy)
  if (!Array.isArray(parsed)) return false
  await writeJsonFile(current, parsed.map((item) => map(item as Json)))
  return true
}

/**
 * Copies the pending proposals of the legacy staging folder, one file per
 * proposal, with the current keys. A proposal that already exists under the new
 * name wins: the approved/created ones are not resurrected.
 */
async function migrateProposals(): Promise<number> {
  const legacy = path.join(dataRoot(), LEGACY_PROPOSALS_DIR)
  if (!(await exists(legacy))) return 0
  const files = await fsp.readdir(legacy).catch(() => [] as string[])
  let migrated = 0
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    const current = path.join(proposalsDir(), name)
    if (await exists(current)) continue
    const parsed = await readJsonFile(path.join(legacy, name))
    // A corrupted proposal is dropped, exactly as the reader would do.
    if (!parsed || typeof parsed !== 'object') continue
    await writeJsonFile(current, mapProposal(parsed as Json))
    migrated++
  }
  return migrated
}

/**
 * One-shot migration of the data written before the domain was renamed: reads
 * `orbit-data/rotinas/rotinas.json` and `runs.json` and writes
 * `orbit-data/routines/routines.json` and `runs.json` with the current keys and
 * enum values (`rodando` → `running`, `erro` → `error`), plus the pending
 * proposals of `orbit-data/rotinas-pending/`, which move to
 * `orbit-data/routine-proposals/`.
 *
 * Safe to run twice: every file is only written when the new one is still
 * missing, and the legacy files stay where they are.
 */
async function migrateLegacyData(): Promise<void> {
  const legacyDir = path.join(dataRoot(), LEGACY_DIR)
  const currentDir = baseDir()
  let migrated = 0

  if (await migrateFile(path.join(legacyDir, LEGACY_ROUTINES), path.join(currentDir, ROUTINES), mapRoutine)) {
    migrated++
  }
  if (await migrateFile(path.join(legacyDir, RUNS), path.join(currentDir, RUNS), mapRun)) migrated++
  migrated += await migrateProposals()

  if (migrated > 0) console.log(`[routines] migrated ${migrated} legacy data file(s) to the English names`)
}

/** Runs the migration once per process, before the first read or write. */
let migration: Promise<void> | undefined

export function ensureMigrated(): Promise<void> {
  migration ??= migrateLegacyData().catch((err) => {
    console.error('[routines] data migration failed:', err)
  })
  return migration
}

// ─── Serial queue ────────────────────────────────────────────────────────────

/** Serial queue per file — same idea as the pipeline repo. */
const queues = new Map<string, Promise<unknown>>()

function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  queues.set(
    file,
    next.catch(() => {}),
  )
  return next
}

async function read<T>(file: string, empty: T): Promise<T> {
  await ensureMigrated()
  try {
    const raw = await fsp.readFile(path.join(baseDir(), file), 'utf8')
    return (JSON.parse(raw) as T) ?? empty
  } catch {
    // missing or corrupted — the UI restarts from the empty state instead of breaking
    return empty
  }
}

async function write(file: string, value: unknown): Promise<void> {
  await ensureMigrated()
  await writeJsonFile(path.join(baseDir(), file), value)
}

// ─── Routines ────────────────────────────────────────────────────────────────

/**
 * Reading routines ALWAYS with the normalization applied — including on the
 * write paths: an `updateRoutine` reading the raw JSON would emit a routine
 * without `mode` in the event, and the renderer filters it out of the mode
 * listing (`r.mode === mode`) — the routine "disappears" when it is turned off.
 * Normalizing here also self-heals the file on the next write.
 */
async function readRoutines(): Promise<Routine[]> {
  return (await read<Routine[]>(ROUTINES, [])).map((routine) => ({ ...routine, mode: routine.mode ?? 'code' }))
}

export function listRoutines(): Promise<Routine[]> {
  return readRoutines()
}

export function saveRoutines(routines: Routine[]): Promise<void> {
  return withLock(ROUTINES, () => write(ROUTINES, routines))
}

/**
 * Updates ONE routine inside the lock. Read-modify-write outside it would lose
 * updates when the scheduler writes `lastRun` while the UI saves the edit of
 * another routine.
 */
export function updateRoutine(id: string, patch: (routine: Routine) => Routine): Promise<Routine | null> {
  return withLock(ROUTINES, async () => {
    const routines = await readRoutines()
    const index = routines.findIndex((r) => r.id === id)
    if (index < 0) return null
    const updated = patch(routines[index])
    routines[index] = updated
    await write(ROUTINES, routines)
    return updated
  })
}

export function addRoutine(routine: Routine): Promise<Routine> {
  return withLock(ROUTINES, async () => {
    const routines = await read<Routine[]>(ROUTINES, [])
    await write(ROUTINES, [...routines, routine])
    return routine
  })
}

export function removeRoutine(id: string): Promise<void> {
  return withLock(ROUTINES, async () => {
    const routines = await read<Routine[]>(ROUTINES, [])
    await write(
      ROUTINES,
      routines.filter((r) => r.id !== id),
    )
  })
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export function listRuns(): Promise<RoutineRun[]> {
  return read<RoutineRun[]>(RUNS, [])
}

/** Inserts or replaces the execution record (key: sessionId). */
export function saveRun(run: RoutineRun): Promise<RoutineRun> {
  return withLock(RUNS, async () => {
    const runs = await read<RoutineRun[]>(RUNS, [])
    const index = runs.findIndex((r) => r.sessionId === run.sessionId)
    if (index >= 0) runs[index] = run
    else runs.push(run)
    await write(RUNS, runs)
    return run
  })
}

export function removeRoutineRuns(routineId: string): Promise<void> {
  return withLock(RUNS, async () => {
    const runs = await read<RoutineRun[]>(RUNS, [])
    await write(
      RUNS,
      runs.filter((r) => r.routineId !== routineId),
    )
  })
}

/**
 * Prunes orphan metrics: the chat of a run was deleted from the sidebar, so the
 * record has nothing left to refer to (the panel list is derived from the
 * sessions). Better to erase it than to keep a "deleted" run around.
 */
export function pruneRuns(liveSessionIds: string[]): Promise<number> {
  return withLock(RUNS, async () => {
    const runs = await read<RoutineRun[]>(RUNS, [])
    const live = new Set(liveSessionIds)
    // A RUNNING run does not have a session in the renderer's store at every
    // moment (creation and the first event race) — do not prune it.
    const remaining = runs.filter((r) => live.has(r.sessionId) || r.status === 'running')
    if (remaining.length === runs.length) return 0
    await write(RUNS, remaining)
    return runs.length - remaining.length
  })
}
