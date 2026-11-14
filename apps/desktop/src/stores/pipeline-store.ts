import { create } from "zustand"
import type { Delivery, PhaseTemplate, Pipeline, PipelineEvent, Project, Task } from "@shared/pipeline"
import { getActivePeer } from "@/src/lib/env-source"
import { pipelineApi, type NewPipelineInput } from "@/src/lib/ipc"

/**
 * Pipeline mode state in the renderer.
 *
 * The main process owns the truth: every mutation goes through IPC and comes
 * back as `pipeline:event` — including the ones the engine fires on its own
 * (phase completed, task paused by an error, queue advancing). That is why the
 * store does no optimistic update of execution: it reflects what the main
 * process confirmed, otherwise the board would show a phase that did not finish.
 */

interface PipelineState {
  projects: Project[]
  pipelines: Pipeline[]
  tasksPerPipeline: Record<string, Task[]>
  templates: PhaseTemplate[]
  /** History of deliveries per pipeline (loaded when the history panel opens) */
  deliveriesPerPipeline: Record<string, Delivery[]>
  loadDeliveries: (pipelineId: string) => Promise<void>
  /** Automatic queues that are on (pipeline id) */
  queueEnabled: Record<string, boolean>
  /** Live text of the running phase, per task */
  progress: Record<string, string>
  /** Live execution per task: thinking (reasoning) + tools */
  activity: Record<string, TaskActivity>
  loaded: boolean
  /** Pipeline open on the board (null = list). The app header reads from here so
   *  it only shows folder/branch once a pipeline has been chosen. */
  openPipelineId: string | null
  setOpenPipeline: (id: string | null) => void

  /** The settings, floating over the board of the open pipeline. */
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  /** The "new task" plan dialog of the open pipeline — opened from the window header. */
  planOpen: boolean
  setPlanOpen: (open: boolean) => void

  load: () => Promise<void>
  applyEvent: (event: PipelineEvent) => void

  createProject: (name: string, folders: string[]) => Promise<Project>
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "folders">>) => Promise<void>
  removeProject: (id: string) => Promise<void>

  saveTemplate: (template: PhaseTemplate) => Promise<void>
  removeTemplate: (id: string) => Promise<void>

  createPipeline: (input: NewPipelineInput) => Promise<Pipeline>
  updatePipeline: (id: string, patch: Partial<Pipeline>) => Promise<void>
  removePipeline: (id: string) => Promise<void>

  createTask: (pipelineId: string, title: string, description: string, dependsOn?: string[]) => Promise<Task>
  updateTask: (pipelineId: string, taskId: string, patch: Partial<Task>) => Promise<void>
  removeTask: (pipelineId: string, taskId: string) => Promise<void>
  startTask: (pipelineId: string, taskId: string, phase?: number) => Promise<void>
  pauseTask: (pipelineId: string, taskId: string) => Promise<void>
  resumeTask: (pipelineId: string, taskId: string, instruction?: string) => Promise<void>
  returnTask: (pipelineId: string, taskId: string, text: string, phase?: number) => Promise<void>
  toggleQueue: (pipelineId: string, enabled: boolean) => Promise<void>

  tasksOf: (pipelineId: string) => Task[]
  pipelinesOf: (projectId: string) => Pipeline[]
}

/**
 * STABLE empty array for the selectors. `s.tasksPerPipeline[id] ?? []` creates a
 * new array on every selector call: zustand compares the snapshot by identity,
 * concludes it changed, re-renders, calls the selector again... and React tears
 * the tree down with "Maximum update depth exceeded". It showed up when creating
 * the pipeline, which is exactly when the key does not exist yet.
 */
export const EMPTY_TASKS: Task[] = []

interface ToolActivity {
  toolCallId: string
  tool: string
  state: "running" | "completed" | "error"
  summary: string
  detail?: string
}

interface TaskActivity {
  phaseIndex: number
  thinking: string
  tools: ToolActivity[]
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  projects: [],
  pipelines: [],
  tasksPerPipeline: {},
  templates: [],
  deliveriesPerPipeline: {},
  queueEnabled: {},
  progress: {},
  activity: {},
  loaded: false,
  openPipelineId: null,
  setOpenPipeline: (id) =>
    set(id ? { openPipelineId: id } : { openPipelineId: null, settingsOpen: false, planOpen: false }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  planOpen: false,
  setPlanOpen: (open) => set({ planOpen: open }),

  load: async () => {
    const peer = getActivePeer()
    const [data, templates] = await Promise.all([pipelineApi.load(), pipelineApi.templates()])
    // The environment moved on while this was in flight: it belongs to a machine no longer shown.
    if (getActivePeer() !== peer) return
    set({
      projects: data.projects,
      pipelines: data.pipelines,
      tasksPerPipeline: data.tasksPerPipeline,
      templates,
      loaded: true,
    })
  },

  loadDeliveries: async (pipelineId) => {
    const deliveries = await pipelineApi.deliveries(pipelineId)
    set((state) => ({ deliveriesPerPipeline: { ...state.deliveriesPerPipeline, [pipelineId]: deliveries } }))
  },

  applyEvent: (event) => {
    switch (event.type) {
      case "deliveries":
        set((state) => ({
          deliveriesPerPipeline: { ...state.deliveriesPerPipeline, [event.pipelineId]: event.deliveries },
        }))
        break
      case "projects":
        set({ projects: event.projects })
        break
      case "pipeline":
        set((state) => {
          const exists = state.pipelines.some((p) => p.id === event.pipeline.id)
          return {
            pipelines: exists
              ? state.pipelines.map((p) => (p.id === event.pipeline.id ? event.pipeline : p))
              : [...state.pipelines, event.pipeline],
          }
        })
        break
      case "task":
        set((state) => {
          const current = state.tasksPerPipeline[event.pipelineId] ?? []
          const exists = current.some((t) => t.id === event.task.id)
          // The task stopped running (completed/paused): live activity is
          // meaningless — the modal goes back to showing the notes.
          const activity =
            event.task.status !== "in_progress" && state.activity[event.task.id]
              ? Object.fromEntries(Object.entries(state.activity).filter(([id]) => id !== event.task.id))
              : state.activity
          return {
            tasksPerPipeline: {
              ...state.tasksPerPipeline,
              [event.pipelineId]: exists
                ? current.map((t) => (t.id === event.task.id ? event.task : t))
                : [...current, event.task],
            },
            activity,
          }
        })
        break
      case "tasks":
        set((state) => ({
          tasksPerPipeline: { ...state.tasksPerPipeline, [event.pipelineId]: event.tasks },
        }))
        break
      case "phase-progress":
        set((state) => ({
          progress: {
            // Only the tail matters on the card — keeping the whole phase text
            // would fill the renderer's memory with nothing on screen.
            [event.taskId]: (state.progress[event.taskId] ?? "").concat(event.text).slice(-600),
            ...Object.fromEntries(Object.entries(state.progress).filter(([id]) => id !== event.taskId)),
          },
        }))
        break
      case "phase-thinking":
        set((state) => {
          const current = state.activity[event.taskId]
          const base =
            current && current.phaseIndex === event.phaseIndex
              ? current
              : { phaseIndex: event.phaseIndex, thinking: "", tools: [] }
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
      case "phase-tool":
        set((state) => {
          const current = state.activity[event.taskId]
          const base =
            current && current.phaseIndex === event.phaseIndex
              ? current
              : { phaseIndex: event.phaseIndex, thinking: "", tools: [] }
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
    const project = await pipelineApi.createProject(name, folders)
    set((state) => ({ projects: [...state.projects, project] }))
    return project
  },
  updateProject: async (id, patch) => {
    await pipelineApi.updateProject(id, patch)
  },
  removeProject: async (id) => {
    await pipelineApi.removeProject(id)
    set((state) => ({
      pipelines: state.pipelines.filter((p) => p.projectId !== id),
      projects: state.projects.filter((p) => p.id !== id),
    }))
  },

  saveTemplate: async (template) => {
    set({ templates: await pipelineApi.saveTemplate(template) })
  },
  removeTemplate: async (id) => {
    set({ templates: await pipelineApi.removeTemplate(id) })
  },

  createPipeline: async (input) => {
    const pipeline = await pipelineApi.create(input)
    set((state) => ({ pipelines: [...state.pipelines, pipeline] }))
    return pipeline
  },
  updatePipeline: async (id, patch) => {
    await pipelineApi.update(id, patch)
  },
  removePipeline: async (id) => {
    await pipelineApi.remove(id)
    set((state) => {
      const rest = Object.fromEntries(Object.entries(state.tasksPerPipeline).filter(([key]) => key !== id))
      return { pipelines: state.pipelines.filter((p) => p.id !== id), tasksPerPipeline: rest }
    })
  },

  createTask: (pipelineId, title, description, dependsOn) =>
    pipelineApi.createTask({ pipelineId, title, description, dependsOn }),
  updateTask: async (pipelineId, taskId, patch) => {
    await pipelineApi.updateTask(pipelineId, taskId, patch)
  },
  removeTask: async (pipelineId, taskId) => {
    await pipelineApi.removeTask(pipelineId, taskId)
  },
  startTask: async (pipelineId, taskId, phase) => {
    await pipelineApi.startTask(pipelineId, taskId, phase)
  },
  pauseTask: async (pipelineId, taskId) => {
    await pipelineApi.pauseTask(pipelineId, taskId)
  },
  resumeTask: async (pipelineId, taskId, instruction) => {
    await pipelineApi.resumeTask(pipelineId, taskId, instruction)
  },
  returnTask: async (pipelineId, taskId, text, phase) => {
    await pipelineApi.returnTask(pipelineId, taskId, text, phase)
  },
  toggleQueue: async (pipelineId, enabled) => {
    const state = await pipelineApi.toggleQueue(pipelineId, enabled)
    set((s) => ({ queueEnabled: { ...s.queueEnabled, [pipelineId]: state } }))
  },

  tasksOf: (pipelineId) => get().tasksPerPipeline[pipelineId] ?? EMPTY_TASKS,
  pipelinesOf: (projectId) => get().pipelines.filter((p) => p.projectId === projectId),
}))
