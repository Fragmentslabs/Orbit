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
  removeTasks,
  savePipelines,
  saveProjects,
  saveCustomTemplates,
} from './repo'
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
    // Older templates (saved before the `kind` field) inherit the role of the
    // built-in with the same id; new user phases fall back to 'generic'.
    const builtIn = PHASE_TEMPLATES.some((e) => e.id === t.id)
    byId.set(t.id, { ...t, kind: t.kind ?? byId.get(t.id)?.kind ?? 'generic', custom: true, userCreated: !builtIn })
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
    tools: t.tools,
    kind: t.kind,
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
    providerId: choice.providerId && choice.modelId ? choice.providerId : input.providerId,
    modelId: choice.providerId && choice.modelId ? choice.modelId : input.modelId,
    thinkingLevel: input.thinkingLevel ?? 0,
    reasoning: choice.reasoning !== undefined ? choice.reasoning : (input.reasoning ?? null),
    ...(choice.templateId ? { templateId: choice.templateId } : {}),
    tools: [...choice.tools],
    kind: choice.kind,
    order,
  }))
}

export async function createPipeline(input: NewPipelineInput): Promise<Pipeline> {
  // A push without the final commit would upload a branch without the task's full
  // state (the phases after development did not commit) — a required dependency,
  // validated here because the IPC can bypass the UI.
  if (input.pushAtEnd && input.commitAtEnd === false) {
    throw new Error('Push at the end requires the final commit to be enabled.')
  }
  const commitPrompt = input.commitPrompt?.trim()
  const pipeline: Pipeline = {
    id: newId('pipe_'),
    projectId: input.projectId,
    name: input.name,
    phases: await copyPhases(input),
    branch: input.branch,
    worktree: input.worktree,
    ...(input.worktreePerTask ? { worktreePerTask: true } : {}),
    operationMode: input.operationMode ?? 'manual',
    pushAtEnd: input.pushAtEnd ?? false,
    commitAtEnd: input.commitAtEnd ?? true,
    ...(commitPrompt ? { commitPrompt } : {}),
    resultScreenshots: input.resultScreenshots ?? false,
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
  const pipelines = await listPipelines()
  const index = pipelines.findIndex((p) => p.id === id)
  if (index < 0) return null
  const previous = pipelines[index]
  const commitAtEnd = patch.commitAtEnd ?? previous.commitAtEnd
  const pushAtEnd = patch.pushAtEnd ?? previous.pushAtEnd
  if (pushAtEnd && commitAtEnd === false) {
    throw new Error('Push at the end requires the final commit to be enabled.')
  }
  // An empty prompt in the patch = back to the default (PIPELINE_COMMIT_PROMPT_DEFAULT).
  if (typeof patch.commitPrompt === 'string') {
    const clean = patch.commitPrompt.trim()
    if (clean) patch = { ...patch, commitPrompt: clean }
    else delete patch.commitPrompt
  }
  pipelines[index] = { ...previous, ...patch }
  await savePipelines(pipelines)
  emit({ type: 'pipeline', pipeline: pipelines[index] })
  return pipelines[index]
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
