import type { Pipeline, PipelineEvent, Project, Task } from '@shared/pipeline'
import { broadcastPipelineEvent } from '../broadcast'
import { listPipelines, listProjects, updateTask } from './repo'

/**
 * Small helpers the engine and the integration queue share: the single funnel
 * of pipeline events, the context of a pipeline and the task write that also
 * tells the windows. Apart from the engine so the two can import it without a
 * cycle.
 */

export function now(): string {
  return new Date().toISOString()
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Single funnel of the pipeline events: windows (renderer) + companions (mobile
 * app) — the mobile app mirrors the whole board through this channel.
 */
export function emit(event: PipelineEvent): void {
  broadcastPipelineEvent(event)
}

export async function loadContext(pipelineId: string): Promise<{ pipeline: Pipeline; project: Project } | null> {
  const pipeline = (await listPipelines()).find((p) => p.id === pipelineId)
  if (!pipeline) return null
  const project = (await listProjects()).find((p) => p.id === pipeline.projectId)
  if (!project) return null
  return { pipeline, project }
}

export async function persist(pipelineId: string, taskId: string, patch: (t: Task) => Task): Promise<Task | null> {
  const task = await updateTask(pipelineId, taskId, patch)
  if (task) emit({ type: 'task', pipelineId, task })
  return task
}

