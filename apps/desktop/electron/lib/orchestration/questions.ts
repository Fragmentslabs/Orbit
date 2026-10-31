import { generateText } from 'ai'
import type { OrchestrationPlan, PermissionMode, Question } from '@shared/chat'
import { resolveModel } from '../providers'

/**
 * A worker's question goes to the orchestrator before it goes to the user.
 *
 * The orchestrator is not a loop that stays on: it is woken for this one call, with
 * what it knows that the worker does not — the user's request and the whole plan —
 * and goes back to standby. How much it decides follows the permission mode, the
 * same autonomy dial the user already set for the run:
 * - full: it answers everything; nothing reaches the user;
 * - approve: it answers, except the hard decisions, which go up to the user;
 * - ask: it answers only the simple ones; anything with real weight goes up.
 *
 * Only orchestra workers ask here (they are the ones with a plan behind them). An
 * ephemeral subagent keeps the old path: its parent is blocked waiting on it.
 */

export interface OrchestratorContext {
  providerId: string
  modelId: string
  /** What the user asked the orchestra for. */
  request: string
  plan: OrchestrationPlan
}

const contexts = new Map<string, () => OrchestratorContext>()

/** While a plan runs, its workers' questions can be answered by the orchestrator. */
export function registerOrchestrator(orchestratorSessionId: string, context: () => OrchestratorContext): () => void {
  contexts.set(orchestratorSessionId, context)
  return () => {
    if (contexts.get(orchestratorSessionId) === context) contexts.delete(orchestratorSessionId)
  }
}

export function hasOrchestrator(orchestratorSessionId: string | undefined): boolean {
  return !!orchestratorSessionId && contexts.has(orchestratorSessionId)
}

export interface Ruling {
  /** Index of the question (0-based). */
  index: number
  answer?: string
  /** Why it goes to the user instead. */
  escalate?: string
}

const RULES: Record<PermissionMode, string> = {
  full:
    'The user put this run in UNRESTRICTED mode: they do not want to be asked. Answer EVERY question yourself, hard ones included — pick the option most faithful to the request and the plan, and the safest when in doubt. Never escalate.',
  approve:
    'The user put this run in AUTONOMOUS mode: decide for them whenever the request, the plan or plain engineering sense settles it — technical choices, naming, structure, which of two reasonable approaches. Escalate ONLY hard decisions: something the user did not settle that changes what they get (scope, product behavior, UX they would notice), anything irreversible or destructive (deleting data, migrations, force pushes), security, money, or going against what the request says.',
  ask:
    'The user put this run in ASK mode: they want to be in the loop. Answer only SIMPLE questions — ones with an obvious or conventional answer that the request, the plan or the codebase\'s own conventions already settle. Escalate anything with real weight: a trade-off between valid approaches, scope or behavior, anything the user would plausibly want a say in, and every hard decision.',
}

function describePlan(plan: OrchestrationPlan, workerTitle: string): string {
  return plan.tasks
    .map((t) => {
      const mark = t.title === workerTitle ? ' ← the worker asking' : ''
      const prompt = t.prompt.replace(/\s+/g, ' ').slice(0, t.title === workerTitle ? 1500 : 300)
      return `- "${t.title}" [${t.phase ?? 'queued'}]${mark}: ${prompt}`
    })
    .join('\n')
}

/** Reads the model's JSON rulings; anything unreadable is escalated (or, in full mode, left to the fallback). */
export function parseRulings(text: string, count: number): Ruling[] {
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    parsed = null
  }
  const items = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
  return Array.from({ length: count }, (_, index) => {
    const item = items.find((r) => Number(r.i) === index + 1)
    if (item && typeof item.answer === 'string' && item.answer.trim()) return { index, answer: item.answer.trim() }
    const why = item && typeof item.escalate === 'string' && item.escalate.trim() ? item.escalate.trim() : 'the orchestrator could not decide'
    return { index, escalate: why }
  })
}

export async function askOrchestrator(params: {
  orchestratorSessionId: string
  workerTitle: string
  questions: Omit<Question, 'id'>[]
  mode: PermissionMode
}): Promise<Ruling[]> {
  const context = contexts.get(params.orchestratorSessionId)?.()
  const count = params.questions.length
  if (!context) return params.questions.map((_, index) => ({ index, escalate: 'no orchestrator running' }))
  try {
    const model = await resolveModel(context.providerId, context.modelId)
    const { text } = await generateText({
      model,
      system: [
        'You are the orchestrator of a team of worker agents. One of your workers stopped to ask questions. You know what it does not: the user\'s request and the whole plan.',
        RULES[params.mode],
        'Reply with a JSON array only, one entry per question: {"i": <number>, "answer": "<the decision, with the one-line reason>"} or {"i": <number>, "escalate": "<why the user must decide>"}.',
      ].join('\n\n'),
      prompt: [
        `## The user's request\n${context.request.slice(0, 4000)}`,
        `## The plan\n${describePlan(context.plan, params.workerTitle)}`,
        `## Questions from "${params.workerTitle}"`,
        params.questions
          .map((q, i) => `${i + 1}. ${q.text}${q.options?.length ? `\n   Options: ${q.options.join(' | ')}` : ''}`)
          .join('\n'),
      ].join('\n\n'),
    })
    const rulings = parseRulings(text, count)
    // Unrestricted means the user is never asked — not even when the reply was unreadable.
    if (params.mode === 'full') {
      return rulings.map((r) => (r.answer ? r : { index: r.index, answer: 'Proceed with the most reasonable and safe option.' }))
    }
    return rulings
  } catch (err) {
    console.warn('[orchestra] the orchestrator could not answer a worker:', err)
    if (params.mode === 'full') {
      return params.questions.map((_, index) => ({ index, answer: 'Proceed with the most reasonable and safe option.' }))
    }
    return params.questions.map((_, index) => ({ index, escalate: 'the orchestrator could not be reached' }))
  }
}
