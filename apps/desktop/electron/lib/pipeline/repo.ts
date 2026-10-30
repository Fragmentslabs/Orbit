import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  AllowedTool,
  PhaseConfig,
  PhaseKind,
  PhaseNote,
  PhaseTemplate,
  Pipeline,
  Project,
  Task,
  TaskReturn,
  ResumeInstruction,
} from '@shared/pipeline'

/**
 * Pipeline mode persistence: JSON in the app data folder (§15), no new database
 * at this stage.
 *
 *   orbit-data/pipeline/projects.json
 *   orbit-data/pipeline/pipelines.json
 *   orbit-data/pipeline/tasks-<pipelineId>.json
 *
 * Atomic writes (tmp + rename) and one serial queue per file: the engine writes
 * on every phase transition while the UI is also editing, and two concurrent
 * writes to the same file would lose one of the versions.
 */

const SAFE_ID = /^[a-zA-Z0-9_-]+$/

/**
 * Folder names of the pipeline data. `LEGACY_DIR` is the folder used before the
 * domain was renamed to English: it is only read once, by `migrateLegacyData`,
 * so that existing installs keep their projects, pipelines and tasks.
 */
const DATA_DIR = 'pipeline'
const LEGACY_DIR = 'esteira'
const LEGACY_FILES: Record<string, string> = {
  'projetos.json': 'projects.json',
  'esteiras.json': 'pipelines.json',
}

function dataRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data')
}

function baseDir(): string {
  return path.join(dataRoot(), DATA_DIR)
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

const TOOL: Record<string, string> = { leitura: 'read', memoria: 'memory' }
const KIND: Record<string, string> = {
  desenvolvimento: 'development',
  validacao: 'validation',
  seguranca: 'security',
  revisao: 'review',
  generico: 'generic',
}
/** Built-in template ids before the English rename; `infra` did not change. */
const TEMPLATE_ID: Record<string, string> = {
  desenvolvimento: 'development',
  validacao: 'validation',
  seguranca: 'security',
  revisao: 'review',
}
/** A pipeline's `templateId` is the comma-joined list of its phases' template ids. */
function templateIdList(value: unknown): string {
  return String(value)
    .split(',')
    .map((id) => TEMPLATE_ID[id] ?? id)
    .join(',')
}
const MODE: Record<string, string> = { automatico: 'automatic' }
const STATUS: Record<string, string> = {
  pendente: 'pending',
  em_progresso: 'in_progress',
  pausada: 'paused',
  concluida: 'completed',
}
const NOTE_STATUS: Record<string, string> = { erro: 'error', pulada: 'skipped' }
const PAUSE_REASON: Record<string, string> = { erro: 'error' }
const DEPENDENCIES: Record<string, string> = { clonadas: 'cloned', vinculadas: 'linked', nenhuma: 'none' }

function mapProject(raw: Json): Project {
  return {
    id: String(raw.id),
    name: pick<string>(raw, 'name', 'nome') ?? '',
    folders: asArray<string>(pick(raw, 'folders', 'pastas')),
    createdAt: pick<string>(raw, 'createdAt', 'criadoEm') ?? '',
    pipelines: asArray<string>(pick(raw, 'pipelines', 'esteiras')),
  }
}

function mapPhaseConfig(raw: Json): PhaseConfig {
  const kind = legacyValue<PhaseKind>(pick(raw, 'kind', 'tipo'), KIND)
  return {
    id: String(raw.id),
    name: pick<string>(raw, 'name', 'nome') ?? '',
    description: pick<string>(raw, 'description', 'descricao') ?? '',
    prompt: (raw.prompt as string) ?? '',
    providerId: (raw.providerId as string) ?? '',
    modelId: (raw.modelId as string) ?? '',
    thinkingLevel: Number(pick<number>(raw, 'thinkingLevel', 'thinkingNivel') ?? 0),
    ...(raw.reasoning !== undefined ? { reasoning: raw.reasoning as PhaseConfig['reasoning'] } : {}),
    ...(raw.templateId !== undefined ? { templateId: legacyValue<string>(raw.templateId, TEMPLATE_ID) } : {}),
    tools: asArray<string>(raw.tools).map((tool) => legacyValue<AllowedTool>(tool, TOOL) ?? 'read'),
    order: Number(pick<number>(raw, 'order', 'ordem') ?? 0),
    ...(kind !== undefined ? { kind } : {}),
  }
}

function mapPhaseTemplate(raw: Json): PhaseTemplate {
  return {
    id: legacyValue<string>(raw.id, TEMPLATE_ID) ?? '',
    name: pick<string>(raw, 'name', 'nome') ?? '',
    description: pick<string>(raw, 'description', 'descricao') ?? '',
    prompt: (raw.prompt as string) ?? '',
    tools: asArray<string>(raw.tools).map((tool) => legacyValue<AllowedTool>(tool, TOOL) ?? 'read'),
    isDefault: (pick<boolean>(raw, 'isDefault', 'padrao') ?? false) as boolean,
    ...(raw.custom !== undefined ? { custom: Boolean(raw.custom) } : {}),
    ...(raw.i18nKey !== undefined ? { i18nKey: legacyValue<string>(raw.i18nKey, TEMPLATE_ID) } : {}),
    ...(pick(raw, 'userCreated', 'doUsuario') !== undefined
      ? { userCreated: Boolean(pick(raw, 'userCreated', 'doUsuario')) }
      : {}),
    kind: legacyValue<PhaseKind>(pick(raw, 'kind', 'tipo'), KIND) ?? 'generic',
  }
}

function mapPipeline(raw: Json): Pipeline {
  const policy = (pick<Json>(raw, 'commandPolicy', 'politicaComandos') ?? {}) as Json
  return {
    id: String(raw.id),
    projectId: String(pick(raw, 'projectId', 'projetoId')),
    name: pick<string>(raw, 'name', 'nome') ?? '',
    phases: asArray<Json>(pick(raw, 'phases', 'fases')).map(mapPhaseConfig),
    ...(raw.branch !== undefined ? { branch: String(raw.branch) } : {}),
    ...(raw.worktree !== undefined ? { worktree: String(raw.worktree) } : {}),
    ...(pick(raw, 'worktreePerTask', 'worktreePorTask') !== undefined
      ? { worktreePerTask: Boolean(pick(raw, 'worktreePerTask', 'worktreePorTask')) }
      : {}),
    operationMode: legacyValue<Pipeline['operationMode']>(pick(raw, 'operationMode', 'modoOperacao'), MODE) ?? 'manual',
    pushAtEnd: Boolean(pick<boolean>(raw, 'pushAtEnd', 'pushAoFinal') ?? false),
    commitAtEnd: Boolean(pick<boolean>(raw, 'commitAtEnd', 'commitAoFinal') ?? true),
    ...(raw.commitPrompt !== undefined ? { commitPrompt: String(raw.commitPrompt) } : {}),
    ...(pick(raw, 'resultScreenshots', 'printsDoResultado') !== undefined
      ? { resultScreenshots: Boolean(pick(raw, 'resultScreenshots', 'printsDoResultado')) }
      : {}),
    commandPolicy: {
      blocked: asArray<string>(pick(policy, 'blocked', 'bloqueados')),
      controlled: asArray<string>(pick(policy, 'controlled', 'controlados')),
    },
    ...(raw.templateId !== undefined ? { templateId: templateIdList(raw.templateId) } : {}),
    createdAt: pick<string>(raw, 'createdAt', 'criadoEm') ?? '',
  }
}

function mapTask(raw: Json): Task {
  const worktree = raw.worktree as Json | undefined
  const diff = raw.diff as Json | undefined
  return {
    id: String(raw.id),
    pipelineId: String(pick(raw, 'pipelineId', 'esteiraId')),
    title: pick<string>(raw, 'title', 'titulo') ?? '',
    description: pick<string>(raw, 'description', 'descricao') ?? '',
    status: legacyValue<Task['status']>(raw.status, STATUS) ?? 'pending',
    currentPhase: (pick<number | null>(raw, 'currentPhase', 'faseAtual') ?? null) as number | null,
    ...(pick(raw, 'pauseReason', 'pausaMotivo') !== undefined
      ? {
          pauseReason: legacyValue<NonNullable<Task['pauseReason']>>(
            pick(raw, 'pauseReason', 'pausaMotivo'),
            PAUSE_REASON,
          ),
        }
      : {}),
    ...(pick(raw, 'error', 'erro') !== undefined ? { error: String(pick(raw, 'error', 'erro')) } : {}),
    ...(pick(raw, 'phaseInterrupted', 'faseInterrompida') !== undefined
      ? { phaseInterrupted: Boolean(pick(raw, 'phaseInterrupted', 'faseInterrompida')) }
      : {}),
    dependsOn: asArray<string>(pick(raw, 'dependsOn', 'dependeDe')),
    notes: asArray<Json>(pick(raw, 'notes', 'anotacoes')).map((note): PhaseNote => ({
      phaseId: String(pick(note, 'phaseId', 'faseId')),
      phaseName: pick<string>(note, 'phaseName', 'faseNome') ?? '',
      status: legacyValue<PhaseNote['status']>(note.status, NOTE_STATUS) ?? 'ok',
      content: pick<string>(note, 'content', 'conteudo') ?? '',
      controlledCommands: asArray<string>(pick(note, 'controlledCommands', 'comandosControlados')),
      ...(note.commitHash !== undefined ? { commitHash: String(note.commitHash) } : {}),
      tokens: Number(note.tokens ?? 0),
      cost: Number(pick<number>(note, 'cost', 'custo') ?? 0),
      startedAt: pick<string>(note, 'startedAt', 'iniciadoEm') ?? '',
      completedAt: pick<string>(note, 'completedAt', 'concluidoEm') ?? '',
      round: Number(pick<number>(note, 'round', 'rodada') ?? 0),
    })),
    createdAt: pick<string>(raw, 'createdAt', 'criadoEm') ?? '',
    ...(pick(raw, 'startedAt', 'iniciadoEm') !== undefined
      ? { startedAt: String(pick(raw, 'startedAt', 'iniciadoEm')) }
      : {}),
    ...(pick(raw, 'completedAt', 'concluidoEm') !== undefined
      ? { completedAt: String(pick(raw, 'completedAt', 'concluidoEm')) }
      : {}),
    workTimeMs: (pick<number>(raw, 'workTimeMs', 'tempoTrabalhoMs') ?? 0) as number,
    tokens: (raw.tokens as number) ?? 0,
    cost: (pick<number>(raw, 'cost', 'custo') ?? 0) as number,
    ...(pick(raw, 'pushError', 'pushFalha') !== undefined
      ? { pushError: String(pick(raw, 'pushError', 'pushFalha')) }
      : {}),
    ...(pick(raw, 'commitError', 'commitFalha') !== undefined
      ? { commitError: String(pick(raw, 'commitError', 'commitFalha')) }
      : {}),
    ...(pick(raw, 'finalCommitHash', 'commitFinalHash') !== undefined
      ? { finalCommitHash: String(pick(raw, 'finalCommitHash', 'commitFinalHash')) }
      : {}),
    ...(raw.round !== undefined || raw.rodada !== undefined
      ? { round: Number(pick(raw, 'round', 'rodada')) }
      : {}),
    ...(pick(raw, 'returns', 'devolucoes') !== undefined
      ? {
          returns: asArray<Json>(pick(raw, 'returns', 'devolucoes')).map((ret): TaskReturn => ({
            round: Number(pick<number>(ret, 'round', 'rodada') ?? 0),
            text: pick<string>(ret, 'text', 'texto') ?? '',
            startPhase: (pick<number>(ret, 'startPhase', 'faseInicial') ?? 0) as number,
            createdAt: pick<string>(ret, 'createdAt', 'criadoEm') ?? '',
          })),
        }
      : {}),
    ...(worktree
      ? {
          worktree: {
            path: pick<string>(worktree, 'path', 'caminho') ?? '',
            folder: pick<string>(worktree, 'folder', 'pasta') ?? '',
            branch: String(worktree.branch),
            base: String(worktree.base),
            dependencies: (legacyValue(worktree.dependencies ?? worktree.dependencias, DEPENDENCIES) ??
              'none') as NonNullable<Task['worktree']>['dependencies'],
            createdAt: pick<string>(worktree, 'createdAt', 'criadoEm') ?? '',
          },
        }
      : {}),
    ...(pick(raw, 'instructions', 'instrucoes') !== undefined
      ? {
          instructions: asArray<Json>(pick(raw, 'instructions', 'instrucoes')).map((instruction): ResumeInstruction => ({
            text: pick<string>(instruction, 'text', 'texto') ?? '',
            round: Number(pick<number>(instruction, 'round', 'rodada') ?? 0),
            phaseId: pick<string>(instruction, 'phaseId', 'faseId') ?? '',
            phaseName: pick<string>(instruction, 'phaseName', 'faseNome') ?? '',
            createdAt: pick<string>(instruction, 'createdAt', 'criadoEm') ?? '',
          })),
        }
      : {}),
    ...(pick(raw, 'previousCommits', 'commitsAnteriores') !== undefined
      ? { previousCommits: asArray<string>(pick(raw, 'previousCommits', 'commitsAnteriores')) }
      : {}),
    ...(pick(raw, 'originSessionId', 'origemSessionId') !== undefined
      ? { originSessionId: String(pick(raw, 'originSessionId', 'origemSessionId')) }
      : {}),
    ...(raw.auto !== undefined ? { auto: Boolean(raw.auto) } : {}),
    ...(diff
      ? {
          diff: {
            start: pick<string>(diff, 'start', 'inicio') ?? '',
            files: asArray<string>(pick(diff, 'files', 'arquivos')),
            patch: (diff.patch as string) ?? '',
          },
        }
      : {}),
  }
}

/** Rewrites a JSON file with the mapped value, only when something changed. */
async function rewriteIfChanged(file: string, value: unknown): Promise<boolean> {
  const serialized = JSON.stringify(value, null, 2)
  const current = await fsp.readFile(file, 'utf8').catch(() => undefined)
  if (current === serialized) return false
  await fsp.writeFile(file, serialized, 'utf8')
  return true
}

/** Maps one file of the data folder according to its name. */
async function migrateFile(file: string): Promise<boolean> {
  const name = path.basename(file)
  const raw = await fsp.readFile(file, 'utf8').catch(() => undefined)
  if (!raw) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false // corrupted file: leave it alone, the UI restarts from the empty state
  }
  if (!Array.isArray(parsed)) return false
  if (name === 'projects.json') return rewriteIfChanged(file, parsed.map((p) => mapProject(p as Json)))
  if (name === 'pipelines.json') return rewriteIfChanged(file, parsed.map((p) => mapPipeline(p as Json)))
  if (name === 'templates.json') return rewriteIfChanged(file, parsed.map((t) => mapPhaseTemplate(t as Json)))
  if (name.startsWith('tasks-')) return rewriteIfChanged(file, parsed.map((t) => mapTask(t as Json)))
  return false
}

/**
 * One-shot migration of the data written before the domain was renamed: moves
 * `orbit-data/esteira/` to `orbit-data/pipeline/`, renames its files
 * (`projetos.json` → `projects.json`, `esteiras.json` → `pipelines.json`; task
 * files keep the `tasks-<id>.json` pattern, since ids are unchanged) and
 * rewrites every JSON with the current keys and enum values.
 *
 * Safe to run twice: once the legacy folder is gone there is nothing to move,
 * and the per-file mapping is a no-op when the content already uses the new
 * names (the file is only rewritten when something actually changed).
 */
async function migrateLegacyData(): Promise<void> {
  const legacy = path.join(dataRoot(), LEGACY_DIR)
  const current = baseDir()
  const legacyStat = await fsp.stat(legacy).catch(() => undefined)
  if (legacyStat?.isDirectory()) {
    // A fresh data folder takes the legacy one over as a whole; if both exist,
    // the new one wins (the migration already ran) and the legacy folder is
    // left untouched.
    if (!(await fsp.stat(current).catch(() => undefined))) {
      await fsp.rename(legacy, current)
      for (const [from, to] of Object.entries(LEGACY_FILES)) {
        await fsp.rename(path.join(current, from), path.join(current, to)).catch(() => {})
      }
      console.log(`[pipeline] migrated data folder from "${LEGACY_DIR}" to "${DATA_DIR}"`)
    }
  }

  const files = await fsp.readdir(current).catch(() => [] as string[])
  let rewritten = 0
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    if (await migrateFile(path.join(current, name))) rewritten++
  }
  if (rewritten > 0) console.log(`[pipeline] migrated ${rewritten} data file(s) to the English field names`)
}

/** Runs the migration once per process, before the first read or write. */
let migration: Promise<void> | undefined

function ensureMigrated(): Promise<void> {
  migration ??= migrateLegacyData().catch((err) => {
    console.error('[pipeline] data migration failed:', err)
  })
  return migration
}

// ─── Serial queue ────────────────────────────────────────────────────────────

/** Serial queue per file — the same idea as the media index. */
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
    const parsed = JSON.parse(raw) as T
    return parsed ?? empty
  } catch {
    // missing or corrupted — the UI restarts from the empty state instead of breaking
    return empty
  }
}

async function write(file: string, value: unknown): Promise<void> {
  await ensureMigrated()
  const dir = baseDir()
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, file)
  const tmp = `${target}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, target)
}

// ─── Projects ────────────────────────────────────────────────────────────────

export function listProjects(): Promise<Project[]> {
  return read<Project[]>('projects.json', [])
}

export function saveProjects(projects: Project[]): Promise<void> {
  return withLock('projects.json', () => write('projects.json', projects))
}

// ─── Pipelines ───────────────────────────────────────────────────────────────

export function listPipelines(): Promise<Pipeline[]> {
  return read<Pipeline[]>('pipelines.json', [])
}

export function savePipelines(pipelines: Pipeline[]): Promise<void> {
  return withLock('pipelines.json', () => write('pipelines.json', pipelines))
}

// ─── Phase templates edited by the user ──────────────────────────────────────

/**
 * Templates the user created or overwrote ("save as default"). They live apart
 * from the built-in ones: that way an Orbit update can improve the factory
 * prompts without erasing what the user wrote, and the shared id tells which
 * built-in one is overwritten.
 */
export function listCustomTemplates(): Promise<PhaseTemplate[]> {
  return read<PhaseTemplate[]>('templates.json', [])
}

export function saveCustomTemplates(templates: PhaseTemplate[]): Promise<void> {
  return withLock('templates.json', () => write('templates.json', templates))
}

// ─── Tasks (one file per pipeline) ───────────────────────────────────────────

function tasksFile(pipelineId: string): string {
  if (!SAFE_ID.test(pipelineId)) throw new Error(`invalid pipeline id: ${pipelineId}`)
  return `tasks-${pipelineId}.json`
}

export function listTasks(pipelineId: string): Promise<Task[]> {
  return read<Task[]>(tasksFile(pipelineId), [])
}

/**
 * ATOMIC read-modify-write of a pipeline's tasks: the read and the write stay
 * INSIDE the same per-file serial lock. Before, `createTask`/`removeTask` read
 * outside the lock and only the write was serial — two concurrent calls read
 * the same snapshot, each wrote "snapshot + its own change", and the last write
 * won: tasks vanished when created in parallel (e.g. chat tools).
 *
 * `fn` receives the current list and mutates it (push/filter/splice); fn's
 * result is returned and the mutated list is written. Never rely on
 * `saveTasks` + a separate read: use this helper.
 */
export function modifyTasks<T>(pipelineId: string, fn: (tasks: Task[]) => T | Promise<T>): Promise<T> {
  const file = tasksFile(pipelineId)
  return withLock(file, async () => {
    const tasks = await read<Task[]>(file, [])
    const result = await fn(tasks)
    await write(file, tasks)
    return result
  })
}

export async function removeTasks(pipelineId: string): Promise<void> {
  const file = tasksFile(pipelineId)
  await ensureMigrated()
  await withLock(file, () => fsp.rm(path.join(baseDir(), file), { force: true }))
}

/**
 * Updates ONE task inside the file's lock: a read-modify-write outside it would
 * lose updates when the engine writes the progress of one phase while the UI
 * saves the edit of another task of the same pipeline.
 */
export function updateTask(
  pipelineId: string,
  taskId: string,
  patch: (task: Task) => Task,
): Promise<Task | null> {
  const file = tasksFile(pipelineId)
  return withLock(file, async () => {
    const tasks = await read<Task[]>(file, [])
    const index = tasks.findIndex((t) => t.id === taskId)
    if (index < 0) return null
    const updated = patch(tasks[index])
    tasks[index] = updated
    await write(file, tasks)
    return updated
  })
}
