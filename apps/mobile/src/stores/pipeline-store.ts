import i18n from '~/i18n'
import { create } from 'zustand'
import type {
  Delivery,
  IntegrationStatus,
  MergeOutcome,
  PlannedTask,
  Pipeline,
  PipelineEvent,
  NewPipelineInput,
  PhaseTemplate,
  Project,
  Task,
} from '@orbit/shared'
import { useConnectionStore } from './connection-store'

/**
 * Pipeline state in the app (mirror of the desktop pipeline-store, but over WS).
 *
 * The desktop main is the source of truth: every mutation goes through a
 * `pipeline:*` request and comes back as a `pipeline:event` — including the ones
 * the engine fires on its own (phase finished, task paused by error, queue
 * moving on, live progress/thinking/tools). That is why there is no optimistic
 * execution update: the screen reflects what the main confirmed.
 *
 * Removals do not emit an event (same limitation as the desktop with several
 * windows): the store removes locally once the request confirms.
 */

interface ToolActivity {
  toolCallId: string
  tool: string
  state: 'running' | 'completed' | 'error'
  summary: string
  detail?: string
}

export interface TaskActivity {
  phaseIndex: number
  thinking: string
  tools: ToolActivity[]
}

/**
 * STABLE empty array for the selectors — `s.tasksByPipeline[id] ?? []` creates a
 * new array on every call and takes zustand down with an infinite re-render
 * ("Maximum update depth exceeded", same fix as the desktop).
 */
export const EMPTY_TASKS: Task[] = []

interface PipelineState {
  projects: Project[]
  pipelines: Pipeline[]
  tasksByPipeline: Record<string, Task[]>
  templates: PhaseTemplate[]
  /** Deliveries (Merge button history) by pipeline */
  deliveriesByPipeline: Record<string, Delivery[]>
  /** Automatic queues that are on (pipeline id) */
  queuesEnabled: Record<string, boolean>
  /** Live text of the running phase, by task */
  progress: Record<string, string>
  /** Live execution by task: thinking (reasoning) + tools */
  activity: Record<string, TaskActivity>
  loading: boolean
  loaded: boolean
  /** Message of the last loading failure (disconnect, desktop error...). */
  error: string | null

  /** Fetches the full snapshot (projects + pipelines + tasks + templates). */
  fetch: () => Promise<void>
  applyEvent: (event: PipelineEvent) => void

  createProject: (name: string, folders: string[]) => Promise<Project>
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'folders'>>) => Promise<void>

  saveTemplate: (template: PhaseTemplate) => Promise<void>

  createPipeline: (input: NewPipelineInput) => Promise<Pipeline>
  updatePipeline: (id: string, patch: Partial<Pipeline>) => Promise<void>
  removePipeline: (id: string) => Promise<void>

  createTask: (pipelineId: string, title: string, description: string, dependsOn?: string[]) => Promise<Task>
  updateTask: (
    pipelineId: string,
    taskId: string,
    patch: Partial<Pick<Task, 'title' | 'description' | 'dependsOn' | 'notes'>>,
  ) => Promise<void>
  removeTask: (pipelineId: string, taskId: string) => Promise<void>
  startTask: (pipelineId: string, taskId: string, phase?: number) => Promise<void>
  pauseTask: (pipelineId: string, taskId: string) => Promise<void>
  resumeTask: (pipelineId: string, taskId: string) => Promise<void>
  toggleQueue: (pipelineId: string, enabled: boolean) => Promise<void>

  tasksOf: (pipelineId: string) => Task[]

  // Integration branch, Merge button, history and planner (all run on the desktop)
  hasGit: (folder: string) => Promise<boolean>
  loadDeliveries: (pipelineId: string) => Promise<void>
  integrationStatus: (pipelineId: string) => Promise<IntegrationStatus | null>
  destinations: (pipelineId: string) => Promise<{ branches: string[]; default?: string }>
  merge: (pipelineId: string, destination?: string) => Promise<MergeOutcome>
  commitIntegration: (pipelineId: string) => Promise<{ ok: boolean; hash?: string; error?: string }>
  retryIntegration: (pipelineId: string, taskId: string) => Promise<void>
  archiveCompleted: (pipelineId: string) => Promise<void>
  deleteDelivery: (pipelineId: string, deliveryId: string) => Promise<void>
  reopenTask: (pipelineId: string, taskId: string) => Promise<Task>
  taskDiff: (pipelineId: string, taskId: string) => Promise<{ files: string[]; patch: string } | null>
  removeTaskImage: (pipelineId: string, taskId: string, url: string) => Promise<void>
  planTasks: (pipelineId: string, request: string) => Promise<PlannedTask[]>
  createPlanned: (pipelineId: string, tasks: PlannedTask[]) => Promise<Task[]>
}

/** One request to the desktop; throws the desktop's message when it fails. */
async function call<T>(request: Parameters<ReturnType<typeof useConnectionStore.getState>['wsClient']['send']>[0], fallback: string): Promise<T> {
  const { wsClient } = useConnectionStore.getState()
  const res = await wsClient.send(request)
  if (!res.ok) throw new Error(res.error ?? fallback)
  return res.data as T
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  projects: [],
  pipelines: [],
  tasksByPipeline: {},
  deliveriesByPipeline: {},
  templates: [],
  queuesEnabled: {},
  progress: {},
  activity: {},
  loading: false,
  loaded: false,
  error: null,

  fetch: async () => {
    const { wsClient, connection } = useConnectionStore.getState()
    set({ loading: true, error: null })
    try {
      // Without a connection send() would stay queued forever — fail fast
      // with a message the screen can show (with a retry button).
      if (connection.status !== 'connected') {
        const failure = i18n.t('pipeline.connectDesktop')
        set({ error: failure })
        console.warn('[pipeline] fetch failed:', failure)
        return
      }
      const res = await wsClient.send({ type: 'pipeline:list' })
      if (res.ok && res.data) {
        const data = res.data as {
          projects: Project[]
          pipelines: Pipeline[]
          tasksByPipeline: Record<string, Task[]>
          templates: PhaseTemplate[]
        }
        set({
          projects: data.projects,
          pipelines: data.pipelines,
          tasksByPipeline: data.tasksByPipeline,
          templates: data.templates,
          loaded: true,
          error: null,
        })
      } else {
        // E.g.: a desktop on an older build answers "unknown request type".
        const failure = res.error ?? 'Failed to load the pipelines'
        set({ error: failure })
        console.warn('[pipeline] fetch failed:', failure)
      }
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err)
      set({ error: failure })
      console.warn('[pipeline] fetch failed:', failure)
    } finally {
      set({ loading: false })
    }
  },

  applyEvent: (event) => {
    switch (event.type) {
      case 'projects':
        set({ projects: event.projects })
        break
      case 'pipeline':
        set((state) => {
          const exists = state.pipelines.some((p) => p.id === event.pipeline.id)
          return {
            pipelines: exists
              ? state.pipelines.map((p) => (p.id === event.pipeline.id ? event.pipeline : p))
              : [...state.pipelines, event.pipeline],
          }
        })
        break
      case 'task':
        set((state) => {
          const current = state.tasksByPipeline[event.pipelineId] ?? []
          const exists = current.some((t) => t.id === event.task.id)
          // The task stopped running (completed/paused): the live activity
          // makes no sense anymore — the detail goes back to showing the notes.
          const activity =
            event.task.status !== 'in_progress' && state.activity[event.task.id]
              ? Object.fromEntries(Object.entries(state.activity).filter(([id]) => id !== event.task.id))
              : state.activity
          return {
            tasksByPipeline: {
              ...state.tasksByPipeline,
              [event.pipelineId]: exists
                ? current.map((t) => (t.id === event.task.id ? event.task : t))
                : [...current, event.task],
            },
            activity,
          }
        })
        break
      case 'tasks':
        set((state) => ({
          tasksByPipeline: { ...state.tasksByPipeline, [event.pipelineId]: event.tasks },
        }))
        break
      case 'deliveries':
        set((state) => ({
          deliveriesByPipeline: { ...state.deliveriesByPipeline, [event.pipelineId]: event.deliveries },
        }))
        break
      case 'phase-progress':
        set((state) => ({
          progress: {
            ...state.progress,
            // Only the tail matters on the card — keeping the whole phase text
            // would fill the app memory without anything showing on screen.
            [event.taskId]: (state.progress[event.taskId] ?? '').concat(event.text).slice(-600),
          },
        }))
        break
      case 'phase-thinking':
        set((state) => {
          const current = state.activity[event.taskId]
          const base =
            current && current.phaseIndex === event.phaseIndex
              ? current
              : { phaseIndex: event.phaseIndex, thinking: '', tools: [] }
          return {
            activity: {
              ...state.activity,
              [event.taskId]: {
                ...base,
                thinking: (base.thinking + event.text).slice(-1200),
              },
            },
          }
        })
        break
      case 'phase-tool':
        set((state) => {
          const current = state.activity[event.taskId]
          const base =
            current && current.phaseIndex === event.phaseIndex
              ? current
              : { phaseIndex: event.phaseIndex, thinking: '', tools: [] }
          const tools = [...base.tools]
          const index = tools.findIndex((t) => t.toolCallId === event.toolCallId)
          const next: ToolActivity = {
            toolCallId: event.toolCallId,
            tool: event.tool,
            state: event.state,
            summary: event.summary,
            detail: event.detail,
          }
          if (index >= 0) tools[index] = next
          else tools.push(next)
          return {
            activity: {
              ...state.activity,
              [event.taskId]: { ...base, tools: tools.slice(-40) },
            },
          }
        })
        break
    }
  },

  createProject: async (name, folders) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:create-project', name, folders })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Failed to create the project')
    const project = res.data as Project
    set((state) => ({ projects: [...state.projects, project] }))
    return project
  },

  updateProject: async (id, patch) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:update-project', id, patch })
    if (!res.ok) throw new Error(res.error ?? 'Failed to update the project')
  },

  saveTemplate: async (template) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:save-template', template })
    if (res.ok && res.data) set({ templates: res.data as PhaseTemplate[] })
  },

  createPipeline: async (input) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:create', input })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Failed to create the pipeline')
    const pipeline = res.data as Pipeline
    set((state) => ({
      pipelines: state.pipelines.some((p) => p.id === pipeline.id) ? state.pipelines : [...state.pipelines, pipeline],
      loaded: true,
    }))
    return pipeline
  },

  updatePipeline: async (id, patch) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:update', id, patch })
    if (!res.ok) throw new Error(res.error ?? 'Failed to update the pipeline')
  },

  removePipeline: async (id) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:delete', id })
    if (!res.ok) throw new Error(res.error ?? 'Failed to delete the pipeline')
    set((state) => {
      const rest = Object.fromEntries(Object.entries(state.tasksByPipeline).filter(([key]) => key !== id))
      return { pipelines: state.pipelines.filter((p) => p.id !== id), tasksByPipeline: rest }
    })
  },

  createTask: async (pipelineId, title, description, dependsOn) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({
      type: 'pipeline:create-task',
      input: { pipelineId, title, description, dependsOn },
    })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Failed to create the task')
    return res.data as Task
  },

  updateTask: async (pipelineId, taskId, patch) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:update-task', pipelineId, taskId, patch })
    if (!res.ok) throw new Error(res.error ?? 'Failed to update the task')
  },

  removeTask: async (pipelineId, taskId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:delete-task', pipelineId, taskId })
    if (!res.ok) throw new Error(res.error ?? 'Failed to delete the task')
  },

  startTask: async (pipelineId, taskId, phase) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:start-task', pipelineId, taskId, phase })
    if (!res.ok) throw new Error(res.error ?? 'Failed to start the task')
  },

  pauseTask: async (pipelineId, taskId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:pause-task', pipelineId, taskId })
    if (!res.ok) throw new Error(res.error ?? 'Failed to pause the task')
  },

  resumeTask: async (pipelineId, taskId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:resume-task', pipelineId, taskId })
    if (!res.ok) throw new Error(res.error ?? 'Failed to resume the task')
  },

  toggleQueue: async (pipelineId, enabled) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'pipeline:toggle-queue', pipelineId, enabled })
    if (!res.ok) throw new Error(res.error ?? 'Failed to toggle the queue')
    set((state) => ({ queuesEnabled: { ...state.queuesEnabled, [pipelineId]: res.data === true } }))
  },

  tasksOf: (pipelineId) => get().tasksByPipeline[pipelineId] ?? EMPTY_TASKS,

  hasGit: (folder) => call<boolean>({ type: 'pipeline:has-git', folder }, 'Failed to check git'),

  loadDeliveries: async (pipelineId) => {
    const deliveries = await call<Delivery[]>({ type: 'pipeline:deliveries', pipelineId }, 'Failed to load the history')
    set((state) => ({ deliveriesByPipeline: { ...state.deliveriesByPipeline, [pipelineId]: deliveries } }))
  },

  integrationStatus: (pipelineId) =>
    call<IntegrationStatus | null>({ type: 'pipeline:integration', pipelineId }, 'Failed to read the integration'),

  destinations: (pipelineId) =>
    call<{ branches: string[]; default?: string }>({ type: 'pipeline:destinations', pipelineId }, 'Failed to list branches'),

  merge: (pipelineId, destination) =>
    call<MergeOutcome>({ type: 'pipeline:merge', pipelineId, destination }, 'Failed to merge'),

  commitIntegration: (pipelineId) =>
    call<{ ok: boolean; hash?: string; error?: string }>({ type: 'pipeline:commit-integration', pipelineId }, 'Failed to commit'),

  retryIntegration: async (pipelineId, taskId) => {
    await call<void>({ type: 'pipeline:retry-integration', pipelineId, taskId }, 'Failed to retry the merge')
  },

  archiveCompleted: async (pipelineId) => {
    await call<void>({ type: 'pipeline:archive-completed', pipelineId }, 'Failed to archive')
  },

  deleteDelivery: async (pipelineId, deliveryId) => {
    await call<void>({ type: 'pipeline:delete-delivery', pipelineId, deliveryId }, 'Failed to delete the delivery')
    set((state) => ({
      deliveriesByPipeline: {
        ...state.deliveriesByPipeline,
        [pipelineId]: (state.deliveriesByPipeline[pipelineId] ?? []).filter((d) => d.id !== deliveryId),
      },
      // The delivery's archived tasks are removed with it.
      tasksByPipeline: {
        ...state.tasksByPipeline,
        [pipelineId]: (state.tasksByPipeline[pipelineId] ?? []).filter((x) => x.deliveryId !== deliveryId),
      },
    }))
  },

  reopenTask: (pipelineId, taskId) => call<Task>({ type: 'pipeline:reopen-task', pipelineId, taskId }, 'Failed to reopen the task'),

  taskDiff: (pipelineId, taskId) =>
    call<{ files: string[]; patch: string } | null>({ type: 'pipeline:task-diff', pipelineId, taskId }, 'Failed to read the diff'),

  removeTaskImage: async (pipelineId, taskId, url) => {
    await call<unknown>({ type: 'pipeline:remove-task-image', pipelineId, taskId, url }, 'Failed to remove the image')
  },

  planTasks: (pipelineId, request) =>
    call<PlannedTask[]>({ type: 'pipeline:plan-tasks', pipelineId, request }, 'Failed to plan the tasks'),

  createPlanned: (pipelineId, tasks) =>
    call<Task[]>({ type: 'pipeline:create-planned', pipelineId, tasks }, 'Failed to create the tasks'),
}))
