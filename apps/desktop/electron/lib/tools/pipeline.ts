import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { loadAll, createPipeline, createProject, createTask, listPipelines, listTasks, startTask, updateTaskFields } from '../pipeline'
import { isEditable, resolveTask, summarizeTask, taskDiff, taskLabel, taskNotes } from '../pipeline/task-ref'

/** Every pipeline with its tasks, for resolving "#12" references. */
async function pipelinesWithTasks() {
  const pipelines = await listPipelines()
  return Promise.all(pipelines.map(async (pipeline) => ({ pipeline, tasks: await listTasks(pipeline.id) })))
}

/**
 * Pipeline tools in the chat: they turn what was discussed in the conversation
 * (a plan, a bug that was found) into a task on a board, without leaving the
 * chat.
 *
 * Disambiguation rule: the tool NEVER guesses the pipeline. When the request does
 * not determine one and there is more than one, it returns the list and tells the
 * model to ask (the `question` tool) — deciding on its own would put the task on
 * the wrong board, which is exactly the kind of mistake nobody notices in time.
 */

interface PipelineSummary {
  id: string
  name: string
  project: string
  phases: string[]
  folders: string[]
}

async function summarizePipelines(): Promise<PipelineSummary[]> {
  const { projects, pipelines } = await loadAll()
  return pipelines.map((pipeline) => {
    const project = projects.find((p) => p.id === pipeline.projectId)
    return {
      id: pipeline.id,
      name: pipeline.name,
      project: project?.name ?? '(project removed)',
      phases: pipeline.phases.map((p) => p.name),
      folders: project?.folders ?? [],
    }
  })
}

/** Matches the user's text against the pipeline/project name (a unique match = no question). */
function filterByName(pipelines: PipelineSummary[], term: string): PipelineSummary[] {
  const target = term.trim().toLowerCase()
  if (!target) return []
  return pipelines.filter(
    (p) => p.name.toLowerCase().includes(target) || p.project.toLowerCase().includes(target),
  )
}

export function createPipelineTools(
  sessionId: string,
  /** Model of the conversation — becomes the default for the phases of the pipeline the agent creates */
  defaultModel: { providerId: string; modelId: string },
): ToolSet {
  return {
    pipeline_create: tool({
      description: [
        'Creates a NEW pipeline (task board): a fixed sequence of phases that runs tasks autonomously, without chats.',
        'Ask the user for the main repository folder before calling — the pipeline has nowhere to work without it.',
        'Phases come from system templates; the default pipeline is development → validation. Only pass other ids if the user asked for something different.',
      ].join(' '),
      inputSchema: z.object({
        name: z.string().describe('Pipeline name, e.g. "Features"'),
        folders: z
          .array(z.string())
          .min(1)
          .describe('Absolute paths; the FIRST one is the main repository'),
        templateIds: z
          .array(z.enum(['development', 'validation', 'security', 'review', 'infra']))
          .optional()
          .describe('Phases in order (default: development, validation)'),
        branch: z.string().optional().describe('Branch the pipeline works on (default: current)'),
      }),
      execute: async ({ name, folders, templateIds, branch }) => {
        // The project (owner of the folders) is born together: the user thinks in
        // terms of "a pipeline in repository X", not in registering a project
        // first.
        const project = await createProject(name, folders)
        const pipeline = await createPipeline({
          projectId: project.id,
          name,
          templateIds: templateIds ?? ['development', 'validation'],
          providerId: defaultModel.providerId,
          modelId: defaultModel.modelId,
          branch,
        })
        return [
          `Pipeline "${pipeline.name}" created — id: ${pipeline.id}`,
          `phases: ${pipeline.phases.map((p) => p.name).join(' → ')}`,
          `main repository: ${folders[0]}`,
          'It shows up on the Pipeline page (code mode sidebar). Use pipeline_create_task to add tasks.',
        ].join('\n')
      },
    }),

    pipeline_list: tool({
      description:
        'Lists the available pipelines (task boards): id, name, project, phases and working folders. Use it before creating a task when you are not sure which board the user means.',
      inputSchema: z.object({}),
      execute: async () => {
        const pipelines = await summarizePipelines()
        if (pipelines.length === 0) {
          return 'No pipeline configured. The user needs to create a project and a pipeline in the Pipeline tab before it can receive tasks.'
        }
        return pipelines
          .map(
            (p) =>
              `- ${p.name} (project: ${p.project}) — id: ${p.id}\n  phases: ${p.phases.join(' → ')}\n  folders: ${p.folders.join(', ') || '(none)'}`,
          )
          .join('\n')
      },
    }),

    pipeline_create_task: tool({
      description: [
        'Creates a task in a pipeline (task board) — use it when the user asks to turn what was discussed into work for a board.',
        'Write `description` as the full brief for an agent that did NOT see this conversation: goal, context, files involved, acceptance criteria and constraints. Everything the pipeline knows comes from it.',
        'Choosing the board: pass `pipelineId` when you know it, or `pipeline` with a name/fragment. If neither is given and there is more than one pipeline, the tool returns the list and you MUST ask the user with the `question` tool — never guess the board.',
        'By default the task is created as pending; the user starts it. Only pass `start: true` when the user explicitly asked to start it now.',
      ].join(' '),
      inputSchema: z.object({
        title: z.string().describe('Short title (one line)'),
        description: z.string().describe('Full brief for an agent with no access to this conversation'),
        pipelineId: z.string().optional().describe('Exact id of the pipeline, from pipeline_list'),
        pipeline: z.string().optional().describe('Name (or fragment) of the pipeline/project, when the id is unknown'),
        start: z.boolean().optional().describe('Start the task right away (default: false)'),
      }),
      execute: async ({ title, description, pipelineId, pipeline, start }) => {
        const available = await summarizePipelines()
        if (available.length === 0) {
          return 'No pipeline configured — there is nowhere to create the task. Ask the user to create a project and a pipeline in the Pipeline tab.'
        }

        let target = pipelineId ? available.find((p) => p.id === pipelineId) : undefined
        if (!target && pipelineId) {
          return `Pipeline "${pipelineId}" not found. Available pipelines:\n${available
            .map((p) => `- ${p.name} (${p.project}) — id: ${p.id}`)
            .join('\n')}`
        }

        if (!target && pipeline) {
          const candidates = filterByName(available, pipeline)
          if (candidates.length === 1) target = candidates[0]
          else if (candidates.length > 1) {
            return `More than one pipeline matches "${pipeline}". Ask the user which one (question tool) and call again with pipelineId:\n${candidates
              .map((p) => `- ${p.name} (${p.project}) — id: ${p.id}`)
              .join('\n')}`
          } else {
            return `No pipeline matches "${pipeline}". Available:\n${available
              .map((p) => `- ${p.name} (${p.project}) — id: ${p.id}`)
              .join('\n')}`
          }
        }

        // No indication at all: a single pipeline is the obvious choice; more than
        // one requires asking — picking the wrong board is a silent mistake.
        if (!target) {
          if (available.length === 1) target = available[0]
          else {
            return `There are ${available.length} pipelines — ask the user which one to create the task in (question tool) and call again with pipelineId:\n${available
              .map((p) => `- ${p.name} (${p.project}) — id: ${p.id}\n  phases: ${p.phases.join(' → ')}`)
              .join('\n')}`
          }
        }

        const task = await createTask({
          pipelineId: target.id,
          title,
          description,
          originSessionId: sessionId,
        })
        if (start) await startTask(target.id, task.id, 0)

        return [
          `Task created in pipeline "${target.name}" (project ${target.project}).`,
          `id: ${task.id} · title: ${task.title}`,
          `phases: ${target.phases.join(' → ')}`,
          start ? 'The task has already been started.' : 'The task is pending — the user starts it from the board.',
        ].join('\n')
      },
    }),

    pipeline_task_status: tool({
      description:
        'Reads the current state of the tasks in a pipeline (status, current phase, errors). Use it to answer questions about how the board is doing.',
      inputSchema: z.object({
        pipelineId: z.string().optional().describe('Pipeline id; omit when there is only one'),
      }),
      execute: async ({ pipelineId }) => {
        const pipelines = await listPipelines()
        if (pipelines.length === 0) return 'No pipeline configured.'
        const target = pipelineId
          ? pipelines.find((p) => p.id === pipelineId)
          : pipelines.length === 1
            ? pipelines[0]
            : undefined
        if (!target) {
          return `Specify the pipeline. Available:\n${pipelines.map((p) => `- ${p.name} — id: ${p.id}`).join('\n')}`
        }
        const tasks = await listTasks(target.id)
        if (tasks.length === 0) return `Pipeline "${target.name}" has no tasks.`
        return tasks
          .map((t) => {
            const phase = t.currentPhase != null ? (target.phases[t.currentPhase]?.name ?? `phase ${t.currentPhase}`) : '—'
            const error = t.pauseReason === 'error' ? ` · error: ${t.error ?? 'no details'}` : ''
            return `- ${taskLabel(t)} [${t.status}] ${t.title} (phase: ${phase})${error}`
          })
          .join('\n')
      },
    }),

    pipeline_task_read: tool({
      description: [
        'Reads what happened in a pipeline task: status, phase notes, rounds, commits and files changed.',
        'Refer to a task by its number as the person says it ("#12") or by id. Numbers are per pipeline: pass `pipelineId`/`pipeline` when the board is known, and if the tool lists several matches, ask the user (question tool).',
        'Default `section` is "summary" (short). Use "notes" for the full phase notes (add `phase` to read one), and "diff" for the files changed (add `file` to read one patch). Read narrowly — notes and patches are long.',
      ].join(' '),
      inputSchema: z.object({
        task: z.string().describe('Task number ("#12" or "12") or task id'),
        pipelineId: z.string().optional().describe('Exact pipeline id, from pipeline_list'),
        pipeline: z.string().optional().describe('Pipeline name (or fragment), when the id is unknown'),
        section: z.enum(['summary', 'notes', 'diff']).optional().describe('What to read (default: summary)'),
        phase: z.string().optional().describe('With section "notes": only the phase whose name matches'),
        file: z.string().optional().describe('With section "diff": the patch of this one file'),
      }),
      execute: async ({ task, pipelineId, pipeline, section, phase, file }) => {
        const found = resolveTask(task, await pipelinesWithTasks(), { pipelineId, pipeline })
        if (!found.ok) return found.message
        if (section === 'notes') return taskNotes(found.task, phase)
        if (section === 'diff') return taskDiff(found.task, file)
        const all = await listTasks(found.pipeline.id)
        return summarizeTask(found.pipeline, found.task, all)
      },
    }),

    pipeline_task_edit: tool({
      description: [
        'Edits the title and/or description of a pipeline task. Only while the task is pending or paused: a running phase has already built its prompt and would not see the change.',
        'The description is the full brief for an agent that did not see the conversation — keep it self-contained. Pass only what changes; `description` replaces the old text entirely, so read the task first (pipeline_task_read) and send the complete new text.',
      ].join(' '),
      inputSchema: z.object({
        task: z.string().describe('Task number ("#12" or "12") or task id'),
        pipelineId: z.string().optional().describe('Exact pipeline id, from pipeline_list'),
        pipeline: z.string().optional().describe('Pipeline name (or fragment), when the id is unknown'),
        title: z.string().optional().describe('New title (one line)'),
        description: z.string().optional().describe('New complete description'),
      }),
      execute: async ({ task, pipelineId, pipeline, title, description }) => {
        if (title === undefined && description === undefined) return 'Nothing to change: pass a title and/or a description.'
        const found = resolveTask(task, await pipelinesWithTasks(), { pipelineId, pipeline })
        if (!found.ok) return found.message
        if (!isEditable(found.task)) {
          return `Task ${taskLabel(found.task)} is ${found.task.status}: it can only be edited while pending or paused. Pause it from the board first, or create a new task.`
        }
        const patch: { title?: string; description?: string } = {}
        if (title !== undefined && title.trim()) patch.title = title.trim()
        if (description !== undefined && description.trim()) patch.description = description.trim()
        if (Object.keys(patch).length === 0) return 'Nothing to change: the title and description cannot be empty.'
        await updateTaskFields(found.pipeline.id, found.task.id, patch)
        return `Task ${taskLabel(found.task)} updated (${Object.keys(patch).join(' and ')}).`
      },
    }),
  }
}
