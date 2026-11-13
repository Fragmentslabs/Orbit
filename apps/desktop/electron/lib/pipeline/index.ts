import type {
  NewPipelineInput,
  PhaseChoice,
  PhaseConfig,
  PhaseTemplate,
  Pipeline,
  PipelineReport,
  Project,
  Task,
} from '@shared/pipeline'
import {
  updateTaskFields,
  createTask,
  discardPipelineWorktrees,
  disableQueue,
  emit,
  enableQueue,
  isQueueEnabled,
  isTaskRunning,
  pauseTask,
  removeTask,
  resumeTask,
  returnTask,
  startTask,
} from './engine'
import {
  listPipelines,
  listProjects,
  listTasks,
  listCustomTemplates,
  patchPipeline,
  removeTasks,
  savePipelines,
  saveProjects,
  saveCustomTemplates,
} from './repo'
import { repositoryRoot } from '../worktrees/core'
import { followUpTitle } from './integration'
import { deleteMediaUrls, stripMediaUrls } from './media-cleanup'
import { persist } from './store'
import { taskLabel } from './task-ref'
import { PHASE_TEMPLATES, DEFAULT_POLICY, defaultTemplates } from './templates'

/**
 * Facade of pipeline mode: this is what the IPC and the chat tools consume. The
 * engine handles execution; here live the CRUD and the assembly of pipelines
 * from the templates.
 */

export {
  createTask,
  startTask,
  pauseTask,
  resumeTask,
  returnTask,
  removeTask,
  updateTaskFields,
  enableQueue,
  disableQueue,
  isQueueEnabled,
  isTaskRunning,
  listTasks,
  listProjects,
  listPipelines,
}
export { abortAll, reconcileExecutions } from './engine'
export {
  archiveCompleted,
  archivedTaskDiff,
  commitIntegration,
  deleteDelivery,
  destinationBranches,
  integrationStatus,
  mergeIntegration,
  retryIntegration,
} from './integration'
export { listDeliveries } from './repo'
export { createPlannedTasks, planTasks } from './planner'

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function now(): string {
  return new Date().toISOString()
}

/**
 * Available templates: the built-in ones + the user's. When the id matches, the
 * user's wins (it is an overwrite of the built-in). Keeping them apart lets an
 * Orbit update improve the factory prompts without erasing what the user wrote.
 */
export async function listTemplates(): Promise<PhaseTemplate[]> {
  const custom = await listCustomTemplates()
  const byId = new Map(PHASE_TEMPLATES.map((t) => [t.id, t]))
  for (const t of custom) {
    const builtIn = PHASE_TEMPLATES.some((e) => e.id === t.id)
    byId.set(t.id, { ...t, custom: true, userCreated: !builtIn })
  }
  return [...byId.values()]
}

/** Creates or overwrites a template ("save as default" in the phase editor). */
export async function saveTemplate(template: PhaseTemplate): Promise<PhaseTemplate[]> {
  const custom = await listCustomTemplates()
  const next: PhaseTemplate = { ...template, custom: true }
  const index = custom.findIndex((t) => t.id === template.id)
  if (index >= 0) custom[index] = next
  else custom.push(next)
  await saveCustomTemplates(custom)
  return listTemplates()
}

/** Removes one of the user's templates. The built-in takes over in place of the overwrite. */
export async function removeTemplate(id: string): Promise<PhaseTemplate[]> {
  const custom = await listCustomTemplates()
  await saveCustomTemplates(custom.filter((t) => t.id !== id))
  return listTemplates()
}

// ─── Projects ────────────────────────────────────────────────────────────────

export async function createProject(name: string, folders: string[]): Promise<Project> {
  const projects = await listProjects()
  const project: Project = { id: newId('proj_'), name, folders, createdAt: now(), pipelines: [] }
  const all = [...projects, project]
  await saveProjects(all)
  emit({ type: 'projects', projects: all })
  return project
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'folders'>>,
): Promise<Project | null> {
  const projects = await listProjects()
  const index = projects.findIndex((p) => p.id === id)
  if (index < 0) return null
  projects[index] = { ...projects[index], ...patch }
  await saveProjects(projects)
  emit({ type: 'projects', projects })
  return projects[index]
}

export async function removeProject(id: string): Promise<void> {
  const projects = await listProjects()
  const pipelines = await listPipelines()
  // The project's pipelines go with it — leaving them orphaned would hide tasks
  // running with no screen to show them on.
  for (const pipeline of pipelines.filter((p) => p.projectId === id)) {
    disableQueue(pipeline.id)
    await discardPipelineWorktrees(pipeline.id)
    await removeTasks(pipeline.id)
  }
  await savePipelines(pipelines.filter((p) => p.projectId !== id))
  const remaining = projects.filter((p) => p.id !== id)
  await saveProjects(remaining)
  emit({ type: 'projects', projects: remaining })
}

// ─── Pipelines ───────────────────────────────────────────────────────────────

/** Pipeline phases = a COPY of what was chosen (D4): editing the pipeline later
 *  never touches the master template. */
async function copyPhases(input: NewPipelineInput): Promise<PhaseConfig[]> {
  const available = await listTemplates()
  const asChoice = (t: PhaseTemplate): PhaseChoice => ({
    templateId: t.id,
    name: t.name,
    description: t.description,
    prompt: t.prompt,
    ...(t.noteContract ? { noteContract: t.noteContract } : {}),
    tools: t.tools,
    ...(t.agent ? { agent: t.agent } : {}),
  })

  let choices = input.phases
  if (!choices?.length) {
    const ids = input.templateIds?.length ? input.templateIds : defaultTemplates().map((t) => t.id)
    choices = ids
      .map((id) => available.find((t) => t.id === id))
      .filter((t): t is PhaseTemplate => !!t)
      .map(asChoice)
  }

  // Model and reasoning: the phase's own when it brings one (edited in the
  // modal), otherwise the pipeline's default.
  return choices.map((choice, order) => ({
    id: newId('phase_'),
    name: choice.name,
    description: choice.description,
    prompt: choice.prompt,
    ...(choice.noteContract ? { noteContract: choice.noteContract } : {}),
    providerId: choice.providerId && choice.modelId ? choice.providerId : input.providerId,
    modelId: choice.providerId && choice.modelId ? choice.modelId : input.modelId,
    thinkingLevel: input.thinkingLevel ?? 0,
    reasoning: choice.reasoning !== undefined ? choice.reasoning : (input.reasoning ?? null),
    ...(choice.templateId ? { templateId: choice.templateId } : {}),
    tools: [...choice.tools],
    ...(choice.agent ? { agent: choice.agent } : {}),
    order,
  }))
}

/** Whether the project's main folder is inside a git repository (worktrees need one). */
export async function hasGit(folder: string | undefined): Promise<boolean> {
  if (!folder) return false
  return repositoryRoot(folder).then(
    () => true,
    () => false,
  )
}

export async function createPipeline(input: NewPipelineInput): Promise<Pipeline> {
  const commitPrompt = input.commitPrompt?.trim()
  // Worktrees are the default — the flow is built around them — but a folder
  // without git cannot have them: that pipeline runs in simple mode.
  const owner = (await listProjects()).find((p) => p.id === input.projectId)
  const worktreePerTask = (input.worktreePerTask ?? true) && (await hasGit(owner?.folders[0]))
  const pipeline: Pipeline = {
    id: newId('pipe_'),
    projectId: input.projectId,
    name: input.name,
    phases: await copyPhases(input),
    branch: input.branch,
    worktree: input.worktree,
    worktreePerTask,
    ...(input.parallelTasks ? { parallelTasks: Math.min(4, Math.max(1, Math.trunc(input.parallelTasks))) } : {}),
    model: { providerId: input.providerId, modelId: input.modelId, reasoning: input.reasoning ?? null },
    operationMode: input.operationMode ?? 'manual',
    commitAtEnd: input.commitAtEnd ?? true,
    ...(commitPrompt ? { commitPrompt } : {}),
    commandPolicy: { blocked: [...DEFAULT_POLICY.blocked], controlled: [...DEFAULT_POLICY.controlled] },
    templateId: input.phases?.map((f) => f.templateId ?? 'custom').join(',') ?? input.templateIds?.join(','),
    createdAt: now(),
  }
  const pipelines = await listPipelines()
  await savePipelines([...pipelines, pipeline])

  const projects = await listProjects()
  const project = projects.find((p) => p.id === input.projectId)
  if (project) {
    project.pipelines = [...project.pipelines, pipeline.id]
    await saveProjects(projects)
    emit({ type: 'projects', projects })
  }
  emit({ type: 'pipeline', pipeline })
  return pipeline
}

export async function updatePipeline(
  id: string,
  patch: Partial<Omit<Pipeline, 'id' | 'projectId' | 'createdAt'>>,
): Promise<Pipeline | null> {
  const index = (await listPipelines()).findIndex((p) => p.id === id)
  if (index < 0) return null
  // An empty prompt in the patch = back to the default (PIPELINE_COMMIT_PROMPT_DEFAULT).
  if (typeof patch.commitPrompt === 'string') {
    const clean = patch.commitPrompt.trim()
    patch = { ...patch, commitPrompt: clean || undefined }
  }
  if (patch.worktreePerTask === true) {
    const owner = (await listPipelines())[index]
    const project = (await listProjects()).find((p) => p.id === owner.projectId)
    if (!(await hasGit(project?.folders[0]))) throw new Error('Worktrees need a git repository in the project folder.')
  }
  if (patch.parallelTasks !== undefined) {
    patch = { ...patch, parallelTasks: Math.min(4, Math.max(1, Math.trunc(patch.parallelTasks))) }
  }
  // Under the file lock: a whole-file write here could undo a task number or an
  // integration worktree recorded a moment ago by the engine.
  const updated = await patchPipeline(id, (p) => ({ ...p, ...patch, nextTaskNumber: p.nextTaskNumber, integration: p.integration }))
  if (!updated) return null
  emit({ type: 'pipeline', pipeline: updated })
  return updated
}

export async function removePipeline(id: string): Promise<void> {
  disableQueue(id)
  await discardPipelineWorktrees(id)
  const pipelines = await listPipelines()
  await savePipelines(pipelines.filter((p) => p.id !== id))
  await removeTasks(id)
  const projects = await listProjects()
  for (const project of projects) {
    project.pipelines = project.pipelines.filter((p) => p !== id)
  }
  await saveProjects(projects)
  emit({ type: 'projects', projects })
}

// ─── Report (§13) ────────────────────────────────────────────────────────────

export async function report(pipelineId: string): Promise<PipelineReport> {
  const tasks = await listTasks(pipelineId)
  const commits = new Set<string>()
  let tokens = 0
  let cost = 0
  let time = 0
  for (const task of tasks) {
    tokens += task.tokens
    cost += task.cost
    time += task.workTimeMs
    for (const note of task.notes) {
      if (note.commitHash) commits.add(note.commitHash)
    }
    // Engine's final commit (commitAtEnd): a hash outside the phases — it enters
    // the report together with the commits made by the phases.
    if (task.finalCommitHash) commits.add(task.finalCommitHash)
    for (const hash of task.previousCommits ?? []) commits.add(hash)
  }
  return {
    pipelineId,
    completedTasks: tasks.filter((t) => t.status === 'completed').length,
    failedTasks: tasks.filter((t) => t.pauseReason === 'error').length,
    tasksInProgress: tasks.filter((t) => t.status === 'in_progress').length,
    pendingTasks: tasks.filter((t) => t.status === 'pending').length,
    createdCommits: [...commits],
    totalTokens: tokens,
    totalCost: cost,
    totalTimeMs: time,
    updatedAt: now(),
  }
}

/** Full snapshot so the UI can open the board in one shot. */
export async function loadAll(): Promise<{
  projects: Project[]
  pipelines: Pipeline[]
  tasksPerPipeline: Record<string, Task[]>
}> {
  const projects = await listProjects()
  const pipelines = await listPipelines()
  const tasksPerPipeline: Record<string, Task[]> = {}
  for (const pipeline of pipelines) {
    tasksPerPipeline[pipeline.id] = await listTasks(pipeline.id)
  }
  return { projects, pipelines, tasksPerPipeline }
}

// ─── History: reopen and image removal ───────────────────────────────────────

/** Reopen: a NEW pending task that follows up a delivered one; the original stays read-only. */
export async function reopenTask(pipelineId: string, taskId: string): Promise<Task> {
  const original = (await listTasks(pipelineId)).find((t) => t.id === taskId)
  if (!original?.deliveryId) throw new Error('Only a delivered task can be reopened.')
  const last = original.notes.filter((n) => n.status === 'ok').at(-1)
  const description = [
    `Follow-up of task ${taskLabel(original)} ("${original.title}"), which was already delivered. Its work is part of the code now; build on it.`,
    '',
    '## Original request',
    original.description.trim() || '(empty)',
    ...(last ? ['', `## What the last phase (${last.phaseName}) reported`, last.content.trim().slice(0, 2000)] : []),
    '',
    '## What to do now',
    '',
  ].join('\n')
  return createTask({ pipelineId, title: followUpTitle(original), description, followUpOf: original.id })
}

/**
 * Deletes one stored image from a task (description or notes) and leaves a
 * placeholder where it was. Works on delivered tasks too: freeing the space is
 * the point.
 */
export async function removeTaskImage(pipelineId: string, taskId: string, url: string): Promise<Task | null> {
  await deleteMediaUrls([url])
  return persist(pipelineId, taskId, (t) => ({
    ...t,
    description: stripMediaUrls(t.description, [url]),
    notes: t.notes.map((n) => ({ ...n, content: stripMediaUrls(n.content, [url]) })),
  }))
}
