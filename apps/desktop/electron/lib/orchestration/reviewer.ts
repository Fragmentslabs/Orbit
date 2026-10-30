import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import type { OrchestrationPlan, OrchestrationSettings, OrchestrationTask } from '@shared/chat'
import type { ReviewActions, ReviewRequest, WorkerResult } from './execution'
import type { Check } from './checks'
import { outsideOwnership } from './ownership'

/**
 * The orchestrator reviewing: a short agent, with tools, instead of the single
 * JSON of before. It sees the worker's result and diff, runs the project checks
 * (mandatory in Rigorous mode, a second channel in the other modes) and decides
 * through the execution's actions.
 */

const MAX_STEPS = 12
const MAX_RESULT = 8000
const DIFF_MAX = 20_000
const MAX_OUTSIDE = 30

export interface ReviewerDeps {
  model: LanguageModel
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions']
  /** Reasoning between steps (models that require the reasoning back, e.g. DeepSeek) */
  prepareStep?: Parameters<typeof generateText>[0]['prepareStep']
  originalRequest: string
  plan: OrchestrationPlan
  config: OrchestrationSettings
  signal: AbortSignal
  /**
   * Diff of the worker's work (worktree or snapshots of its chat). Comes back
   * with the UNAVAILABLE diff notice when capturing the snapshots failed —
   * there was no way to record what the turns wrote.
   */
  diff(task: OrchestrationTask): Promise<string>
  /** Files the worker changed, relative to the chat folder (null = could not be known) */
  touchedFiles?(task: OrchestrationTask): Promise<string[] | null>
  /** Project checks available for the worker's folder */
  checks?(task: OrchestrationTask): Promise<Check[]>
  runCheck?(task: OrchestrationTask, check: Check): Promise<{ ok: boolean; output: string }>
  /** Token usage of the review (added to the plan) */
  onUsage?(usage: unknown): void
}

const SYSTEM = (config: OrchestrationSettings) => `You are the Orbit orchestrator, reviewing the work of the workers you dispatched. Decide with your tools — your text reply is not read by anyone.

How to review:
- Judge the WORK, not the worker's story: look at the diff (show_diff) before accepting anything that should have changed files. If the summary claims something the diff does not show, that is a problem.
- A diff reported as UNAVAILABLE is NOT "nothing was written": the engine failed to record what a turn did. Never request_adjustment just because the diff is empty in that case — check the folder or run run_check and judge by what it says.
- accept when the task is done well enough for the user's request.
- request_adjustment with a concrete, actionable instruction (what is wrong, where, what to do) when something is missing or broken. The same worker continues in its own chat, so it remembers what it did.
- mark_failed when the task cannot be fixed within the budget or went in a wrong direction — say why, so the final answer can tell the user.
- create_worker only for work that is genuinely missing and belongs to no existing worker (it also costs budget).
- Each task owns a list of files. When the review lists files changed OUTSIDE that list, judge them: a small, necessary touch (an import, an export, a shared string) is fine; reworking a file another task owns is not — request_adjustment to undo it or to explain why it was needed. In a shared folder, a file owned by another task may simply be that worker's change: check the diff before blaming this one.
${config.behavior === 'rigorous' ? '- RIGOROUS mode: before accepting a task that changed code, run at least one relevant verification with run_check. A failing check means request_adjustment (or mark_failed without budget), never accept.\n' : '- run_check is available in this mode: run one of the project checks (typecheck, tests, lint) when the diff is unavailable or when reading the diff is not enough to decide.\n'}- Workers may share the same folder: a diff can include changes from other workers running at the same time. Judge only what belongs to this task.`

function budgetText(plan: OrchestrationPlan, config: OrchestrationSettings, task?: OrchestrationTask): string {
  const r = plan.review
  const overall = r ? `${r.maxAdjustments - r.adjustmentsUsed} of ${r.maxAdjustments} adjustments left in the plan` : ''
  const own = task ? `; this worker used ${task.revisions ?? 0} of ${config.adjustmentsPerWorker}` : ''
  return `Budget: ${overall}${own}.`
}

function tasksSummary(plan: OrchestrationPlan): string {
  return plan.tasks
    .map((t) => `- ${t.title} [${t.phase ?? t.status}]${t.extra ? ' (extra)' : ''}${t.files?.length ? ` (files: ${t.files.join(', ')})` : ''}${t.reviewNote ? ` — ${t.reviewNote.slice(0, 200)}` : ''}`)
    .join('\n')
}

/** "changed outside its list" section — empty when there is no list, nothing to point out, or it could not be known. */
async function outsideOwnershipText(d: ReviewerDeps, task: OrchestrationTask): Promise<string> {
  if (!task.files?.length || !d.touchedFiles) return ''
  const touched = await d.touchedFiles(task).catch(() => null)
  if (!touched) return ''
  const outside = outsideOwnership(task, touched, d.plan.tasks)
  if (outside.length === 0) return ''
  const lines = outside.slice(0, MAX_OUTSIDE).map((f) => `- ${f.file}${f.owner ? ` (owned by "${f.owner.title}")` : ''}`)
  if (outside.length > MAX_OUTSIDE) lines.push(`- …and ${outside.length - MAX_OUTSIDE} more`)
  return `## Files changed OUTSIDE its list\n${lines.join('\n')}`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(cut, ${text.length - max} more chars)` : text
}

/** Finds the task by title (integration) — the model does not handle ids well. */
function taskByTitle(plan: OrchestrationPlan, title: string): OrchestrationTask | undefined {
  const target = title.trim().toLowerCase()
  return plan.tasks.find((t) => t.title.trim().toLowerCase() === target || t.id === title)
}

export async function reviewWithModel(d: ReviewerDeps, request: ReviewRequest, actions: ReviewActions): Promise<void> {
  const { plan, config } = d
  const single = request.type === 'worker' ? request.task : undefined
  const target = (title?: string): OrchestrationTask | string => {
    if (single) return single
    const t = title ? taskByTitle(plan, title) : undefined
    return t ?? `No task titled "${title}". Tasks: ${plan.tasks.map((x) => x.title).join(', ')}`
  }
  // Reviewing a single worker, the action applies to it; in the integration, to
  // the named task. Always optional in the schema so both cases share the format.
  const taskField = {
    task: z
      .string()
      .optional()
      .describe(single ? 'Leave empty: this review is about one task' : 'Exact title of the task'),
  }

  const tools: ToolSet = {
    show_diff: tool({
      description: 'Shows the files and patch the worker changed.',
      inputSchema: z.object({ ...taskField }),
      execute: async (args: { task?: string }) => {
        const t = target(args.task)
        if (typeof t === 'string') return t
        const diff = await d.diff(t)
        return diff ? clip(diff, DIFF_MAX) : '(no changes found)'
      },
    }),
    accept: tool({
      description: 'Accepts the task as done.',
      inputSchema: z.object({ ...taskField, note: z.string().optional().describe('Short note on what was verified') }),
      execute: async (args: { task?: string; note?: string }) => {
        const t = target(args.task)
        return typeof t === 'string' ? t : actions.accept(t.id, args.note)
      },
    }),
    request_adjustment: tool({
      description: 'Sends the worker back to work with a concrete instruction. Costs one adjustment from the budget.',
      inputSchema: z.object({ ...taskField, instruction: z.string().describe('What is wrong and exactly what to do') }),
      execute: async (args: { task?: string; instruction: string }) => {
        const t = target(args.task)
        return typeof t === 'string' ? t : actions.requestAdjustment(t.id, args.instruction)
      },
    }),
    mark_failed: tool({
      description: 'Marks the task as failed (it will not run again).',
      inputSchema: z.object({ ...taskField, reason: z.string() }),
      execute: async (args: { task?: string; reason: string }) => {
        const t = target(args.task)
        return typeof t === 'string' ? t : actions.markFailed(t.id, args.reason)
      },
    }),
    create_worker: tool({
      description: 'Creates an additional worker for missing work that belongs to no existing worker. Costs one adjustment from the budget.',
      inputSchema: z.object({
        title: z.string().describe("2-5 words naming the area or deliverable, in the user's language"),
        prompt: z.string().describe('Self-contained prompt — the worker does not see this conversation'),
        dependsOn: z.array(z.string()).optional().describe('Titles of tasks that must be accepted before it starts'),
      }),
      execute: async (args: { title: string; prompt: string; dependsOn?: string[] }) => actions.createWorker(args),
    }),
  }

  if (d.checks && d.runCheck) {
    const checks = d.checks
    const run = d.runCheck
    tools.run_check = tool({
      // In Rigorous mode the check is the mandatory path; in the other modes it
      // is the second channel, for when the diff did not come (failed capture)
      // or reading the patch is not enough to decide.
      description:
        "Runs one of the project's own checks (typecheck, tests, lint) in the worker's folder. Call without `check` to list them." +
        (config.behavior === 'rigorous' ? '' : ' Use it when the diff is unavailable or inconclusive.'),
      inputSchema: z.object({ ...taskField, check: z.string().optional().describe('Name from the list') }),
      execute: async (args: { task?: string; check?: string }) => {
        const t = target(args.task)
        if (typeof t === 'string') return t
        const list = await checks(t)
        if (list.length === 0) return 'This project declares no checks (no typecheck/test/lint scripts). Review the diff instead.'
        const v = list.find((x) => x.name === args.check)
        if (!v) return `Available checks: ${list.map((x) => x.name).join(', ')}`
        const r = await run(t, v)
        return `${v.name}: ${r.ok ? 'PASSED' : 'FAILED'}\n${r.output}`
      },
    })
  }

  const content =
    request.type === 'worker'
      ? [
          `## Original request\n${d.originalRequest}`,
          `## Task under review: ${request.task.title}\n${request.task.prompt}`,
          request.task.files?.length ? `## Files it owns\n${request.task.files.join(', ')}` : '',
          await outsideOwnershipText(d, request.task),
          request.task.revisions ? `## Last adjustment you asked for\n${request.task.reviewNote ?? ''}` : '',
          `## Worker's reply${request.result.error ? ` (ERROR: ${request.result.error})` : ''}\n${clip(request.result.text || '(no reply)', MAX_RESULT)}`,
          `## Other tasks\n${tasksSummary(plan)}`,
          budgetText(plan, config, request.task),
          'Review this task and decide: accept, request_adjustment or mark_failed (and create_worker if something is missing).',
        ]
      : [
          `## Original request\n${d.originalRequest}`,
          `## Every task, after its own review\n${tasksSummary(plan)}`,
          `## Worker replies\n${plan.tasks
            .map((t) => `### ${t.title}\n${clip(resultFor(request.results, t)?.text || '(no reply)', 2500)}`)
            .join('\n\n')}`,
          budgetText(plan, config),
          'INTEGRATION review: do the parts, together, deliver what the user asked? Look for gaps between tasks, contradictions and missing glue. If everything is fine, do nothing (or accept). Otherwise use request_adjustment / create_worker on what is missing.',
        ]

  const { usage } = await generateText({
    model: d.model,
    system: SYSTEM(config),
    messages: [{ role: 'user', content: content.filter(Boolean).join('\n\n') }],
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: d.signal,
    providerOptions: d.providerOptions,
    prepareStep: d.prepareStep,
  })
  d.onUsage?.(usage)
}

function resultFor(results: Map<string, WorkerResult>, t: OrchestrationTask): WorkerResult | undefined {
  return results.get(t.id)
}
