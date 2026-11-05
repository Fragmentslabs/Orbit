import { generateText } from 'ai'
import type { PlannedTask, Task } from '@shared/pipeline'
import { pipelineModel } from '@shared/pipeline'
import { pathsTouch } from '../orchestration/ownership'
import { getProvider } from '../catalog'
import { resolveModel } from '../providers'
import { withProviderSession } from '../provider-session'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from '../reasoning'
import { createTask } from './engine'
import { listPipelines, listTasks } from './repo'
import { taskLabel } from './task-ref'

/**
 * Turns a loose request into tasks, with the pipeline model. Two steps, like the
 * routines: `planTasks` only PROPOSES (nothing is created), the person edits and
 * approves, and `createPlannedTasks` creates them.
 *
 * Dependencies are not left to the model alone: two tasks that touch the same
 * files are chained (the later one waits for the earlier one), which is what
 * keeps parallel tasks from fighting over a file.
 */

const SYSTEM = `You split a request into tasks for a task pipeline. Each task goes through the pipeline's phases on its own, by an agent that has NOT seen this conversation.

Rules:
- Make as few tasks as the request needs: one when it is one piece of work, several only when the parts are independent deliverables.
- "description" must be a complete, self-contained brief: what to do, where, constraints, how to know it is done. Never refer to "the above".
- "files" lists the files or folders the task is likely to touch (paths relative to the project; a folder or a glob is fine). Be honest: this decides which tasks may run together.
- "dependsOn" lists the 0-based indexes of EARLIER tasks that must be finished first because this one builds on their result. Tasks that merely touch the same files are chained for you — do not add those.
- Do not duplicate work already listed as existing tasks.

Answer with ONLY a JSON array, no prose, no fences:
[{"title": "...", "description": "...", "files": ["..."], "dependsOn": []}]`

function parseJson(text: string): unknown {
  const body = text.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('The model did not return a list of tasks.')
  return JSON.parse(body.slice(start, end + 1))
}

/**
 * Cleans what the model returned and adds the file-based dependencies. Pure, so
 * it is tested without a model: drops empty tasks, keeps only backward
 * dependencies (which makes a cycle impossible) and chains tasks that touch the
 * same files.
 */
export function normalizePlan(raw: unknown): PlannedTask[] {
  if (!Array.isArray(raw)) return []
  const tasks: PlannedTask[] = []
  const kept: number[] = [] // raw index -> position in `tasks` (or -1)
  raw.forEach((item, rawIndex) => {
    const o = (item ?? {}) as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const description = typeof o.description === 'string' ? o.description.trim() : ''
    if (!title || !description) {
      kept[rawIndex] = -1
      return
    }
    const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string' && !!f.trim()).map((f) => f.trim()) : []
    const wanted = Array.isArray(o.dependsOn) ? o.dependsOn : []
    const dependsOn = [...new Set(wanted.filter((d): d is number => Number.isInteger(d) && d >= 0 && (kept[d] ?? -1) >= 0).map((d) => kept[d]))]
    kept[rawIndex] = tasks.length
    tasks.push({ title, description, files, dependsOn })
  })
  // Same files → the later task waits for the earlier one.
  tasks.forEach((task, i) => {
    for (let j = 0; j < i; j++) {
      if (task.dependsOn.includes(j)) continue
      if (task.files.some((a) => tasks[j].files.some((b) => pathsTouch(a, b)))) task.dependsOn.push(j)
    }
    task.dependsOn.sort((a, b) => a - b)
  })
  return tasks
}

export async function planTasks(pipelineId: string, request: string): Promise<PlannedTask[]> {
  const text = request.trim()
  if (!text) throw new Error('Describe what you want done.')
  const pipeline = (await listPipelines()).find((p) => p.id === pipelineId)
  if (!pipeline) throw new Error('Pipeline not found.')
  const chosen = pipelineModel(pipeline)
  if (!chosen) throw new Error('The pipeline has no model.')

  const existing = (await listTasks(pipelineId)).filter((t) => !t.deliveryId)
  const context =
    `# Request\n${text}\n\n# Pipeline "${pipeline.name}"\nPhases: ${pipeline.phases.map((p) => p.name).join(' → ')}\n` +
    (existing.length
      ? `\n# Existing tasks (do not duplicate)\n${existing.map((t) => `- ${taskLabel(t)} ${t.title}`).join('\n')}`
      : '')

  const provider = await getProvider(chosen.providerId).catch(() => undefined)
  const model = await resolveModel(chosen.providerId, chosen.modelId)
  const providerOptions = await buildProviderOptions({
    sessionId: `pipeline_plan_${pipelineId}`,
    text,
    providerId: chosen.providerId,
    modelId: chosen.modelId,
    mode: 'code',
    options: { permissionMode: 'full' },
  })
  const { text: answer } = await withProviderSession(`pipeline_plan_${pipelineId}`, () =>
    generateText({
      model,
      system: SYSTEM,
      messages: normalizeMessages([{ role: 'user', content: context }], interleavedReasoningField(provider, chosen.modelId)),
      providerOptions,
    }),
  )
  const plan = normalizePlan(parseJson(answer))
  if (plan.length === 0) throw new Error('The model proposed no tasks.')
  return plan
}

/** Creates the approved tasks (pending — starting them stays the person's call). */
export async function createPlannedTasks(pipelineId: string, planned: PlannedTask[]): Promise<Task[]> {
  const created: Task[] = []
  for (const item of planned) {
    const dependsOn = item.dependsOn.map((i) => created[i]?.id).filter((id): id is string => !!id)
    const task = await createTask({ pipelineId, title: item.title, description: item.description, dependsOn })
    created.push(task)
  }
  return created
}
