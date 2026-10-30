import { BrowserWindow } from 'electron'
import type { InitEvent, InitStage, Memory } from '@shared/memory'
import { normalizeDirectory } from '../memory/domain'
import * as memoryService from '../memory/service'
import { resolveModel } from '../providers'
import { withProviderSession } from '../provider-session'
import { commitDraft, type CommitResult } from './commit'
import { DEFAULT_EXPLORER_BUDGET, runCoordinator, type CoordinatorHooks } from './coordinator'
import { validateDraft, type ExistingTree } from './draft'
import { describeScan, scanProject } from './scanner'

/**
 * /init: an autonomous coordinator analyzes the project and assembles a DRAFT of the
 * memory tree (see coordinator.ts and draft.ts); only at the end, with the
 * draft reviewed, everything is written at once.
 *
 * The previous version was a fixed pipeline: a planner that read nothing
 * chose at least three "areas" per scope, and the code repeated that for the
 * root and for each subproject — in a monorepo, 20 to 30 agents, and generic
 * memories that cost tokens in every following chat. Now whoever decides
 * shape, depth and how many explorers to use is an agent that has seen the
 * project; the code only imposes the limits and the consistency of the tree.
 */

const running = new Set<string>()
/**
 * Controller per folder — it is what gives the stop button some effect over the
 * analysis. Without it, aborting the chat session ended only the UI and the agents
 * kept running to the end.
 */
const initAborts = new Map<string, AbortController>()

/** Cancellation error — distinguished from the real error so the UI does not shout failure. */
export class InitAbortedError extends Error {
  constructor() {
    super('Analysis cancelled.')
    this.name = 'InitAbortedError'
  }
}

export function isInitAborted(err: unknown): boolean {
  return (
    err instanceof InitAbortedError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'InitAbortedError'))
  )
}

/** Cancels the analysis in progress of a folder. Idempotent. */
export function abortProjectInit(directory: string): boolean {
  const controller = initAborts.get(directory)
  if (!controller) return false
  controller.abort()
  return true
}

/** Name of the language (in English, e.g. "Portuguese") coming from the
 * user preference — falls back to "Portuguese" when absent (historical behavior of
 * /init before this field existed). */
function outputLanguage(language?: string): string {
  return language ?? 'Portuguese'
}

function emit(stage: InitStage, data: Partial<InitEvent>) {
  const event: InitEvent = { directory: '', stage, ...data } as InitEvent
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('init:event', event)
  }
}

/** UI callbacks: the chat-engine turns them into parts (accordions) of the message. */
export type InitHooks = CoordinatorHooks

export interface RunInitInput {
  directory: string
  providerId: string
  modelId: string
  workerProviderId?: string
  workerModelId?: string
  /** Kept for compatibility with "/init --force": the analysis always starts from the existing tree. */
  force?: boolean
  /** Explorers in parallel (1-6, default 3). */
  concurrency?: number
  hooks?: InitHooks
  /** Preferred language of the user (name in English, e.g. "Portuguese"). */
  language?: string
  /**
   * External cancellation. /init runs inside a chat session, so the
   * stop button aborts the session controller — this signal is what carries
   * that abort to the agents.
   */
  signal?: AbortSignal
}

export interface InitResult extends CommitResult {
  /** Final word of the coordinator to the user. */
  note?: string
  explorers: number
  /** The coordinator stopped without calling finish (step limit or just stopped) — the draft, if consistent, was written anyway. */
  unfinished: boolean
}

function treeText(nodes: memoryService.TreeNodeSummary[]): string {
  return nodes
    .map((n) => {
      const indent = '  '.repeat(Math.min(n.depth, 6))
      const tag = n.area ? `[${n.area}]` : n.category ? `[${n.category}]` : ''
      const sub = n.subproject ? ` (folder ${n.subproject})` : ''
      const text = n.text.length > 160 ? `${n.text.slice(0, 160)}…` : n.text
      return `${indent}#${n.id} ${tag}${sub} ${text}`
    })
    .join('\n')
}

export async function runProjectInit(input: RunInitInput): Promise<InitResult> {
  return withProviderSession(`init:${input.directory}`, () => runProjectInitInner(input))
}

async function runProjectInitInner(input: RunInitInput): Promise<InitResult> {
  const { directory } = input
  const hooks = input.hooks ?? {}
  const main = (text: string) => hooks.onMainDelta?.(text)

  // Folder already covered by a project above: the analysis works on its tree,
  // focused on the subfolder. Creating a separate tree for "front" would hide
  // the parent folder's (the closest project wins) and split the context.
  const scope = await memoryService.resolveProjectScope(directory)
  const rootDirectory = scope.directory
  const runKey = normalizeDirectory(rootDirectory)
  if (running.has(runKey)) {
    throw new Error('There is already an analysis running for this project.')
  }
  running.add(runKey)

  // Its own controller per folder, chained to the external signal when it exists.
  // The external one covers the /init fired inside a chat session (the stop button
  // aborts the session); the registry covers the init:stop coming from the card, which
  // runs outside any session.
  const controller = new AbortController()
  const signal = controller.signal
  initAborts.set(directory, controller)
  const onExternalAbort = () => controller.abort()
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    emit('scanning', { directory })
    main('Escaneando a estrutura do projeto…\n')
    const scan = await scanProject(rootDirectory)
    const scanDescription = describeScan(scan)
    if (signal.aborted) throw new InitAbortedError()

    const model = await resolveModel(input.providerId, input.modelId)
    const workerProviderId = input.workerProviderId ?? input.providerId
    const workerModelId = input.workerModelId ?? input.modelId
    const workerModel = await resolveModel(workerProviderId, workerModelId)

    const members = (await memoryService.list()).filter(
      (m: Memory) => m.kind === 'project' && m.projectId === scope.projectId && (m.expiresAt == null || m.expiresAt > Date.now()),
    )
    const existing: ExistingTree = {
      ids: new Set(members.map((m) => m.id)),
      // Only a real overview is a root: without it, the new tree is born with its own
      // root instead of "updating" some arbitrary memory of greater weight.
      rootId: members.find((m) => m.area === 'overview' && !m.subproject)?.id,
    }
    const existingTreeText = members.length ? treeText(await memoryService.tree(scope.projectId)) : undefined
    if (members.length) main(`The project already has ${members.length} memory(ies); the analysis starts from them.\n`)

    emit('exploring', { directory, progress: { done: 0, total: 0 } })
    const coordination = await runCoordinator({
      directory: rootDirectory,
      scanDescription,
      existingTreeText,
      existing,
      focus: scope.covered ? scope.subproject : undefined,
      model,
      providerId: input.providerId,
      modelId: input.modelId,
      workerModel,
      workerProviderId,
      workerModelId,
      explorerBudget: DEFAULT_EXPLORER_BUDGET,
      concurrency: Math.max(1, Math.min(input.concurrency ?? 3, 6)),
      language: outputLanguage(input.language),
      hooks: {
        ...hooks,
        onProgress: (done, total) => {
          hooks.onProgress?.(done, total)
          emit('exploring', { directory, progress: { done, total } })
        },
      },
      signal,
    })
    if (signal.aborted) throw new InitAbortedError()

    const { draft } = coordination
    const empty = draft.nodes.size === 0 && draft.learnings.length === 0 && draft.retired.size === 0
    const issues = validateDraft(draft, existing)
    if (empty || issues.length) {
      if (issues.length) {
        main(`\nThe draft did not come out consistent, so nothing was saved:\n${issues.map((i) => `- ${i}`).join('\n')}\n`)
      }
      emit('done', { directory, areas: [] })
      return {
        saved: false,
        created: 0,
        updated: 0,
        retired: 0,
        learnings: 0,
        titles: [],
        note: coordination.note,
        explorers: coordination.explorersUsed,
        unfinished: !coordination.finished,
      }
    }

    emit('saving', { directory })
    main('\nSaving the memory tree…\n')
    const committed = await commitDraft(draft, { rootDirectory, existing })
    emit('done', { directory, areas: committed.saved ? ['overview'] : [] })
    return {
      ...committed,
      note: coordination.note,
      explorers: coordination.explorersUsed,
      unfinished: !coordination.finished,
    }
  } catch (err) {
    // Cancelling is not failing: the event goes out as "done" without areas so the UI
    // ends the progress instead of showing an error the user caused.
    if (isInitAborted(err) || signal.aborted) {
      emit('done', { directory, areas: [] })
      throw new InitAbortedError()
    }
    emit('error', { directory, error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    running.delete(runKey)
    if (initAborts.get(directory) === controller) initAborts.delete(directory)
    input.signal?.removeEventListener('abort', onExternalAbort)
  }
}

export async function getInitStatus(directory: string): Promise<{ directory: string; initialized: boolean; running: boolean }> {
  const scope = await memoryService.resolveProjectScope(directory)
  return {
    directory,
    // Covered by a tree in it or in a folder above: the card does not offer
    // analyzing "front" again when the parent folder was already analyzed.
    initialized: scope.covered,
    running: running.has(normalizeDirectory(scope.directory)),
  }
}
