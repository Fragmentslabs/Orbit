import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import type { OrchestrationTask, SendMessageInput } from '@shared/chat'
import { SUBAGENT_EMPTY_OUTPUT, SUBAGENT_NO_FOLDER_NOTICE } from '@shared/chat'
import { createToolApproval } from '../permission'
import { buildSystemPrompt } from '../prompts'
import { getProvider } from '../catalog'
import { resolveModel } from '../providers'
import { buildProviderOptions, reasoningPrepareStep } from '../reasoning'
import type { ToolContext } from './context'
import { buildToolSet } from './index'
import { modoGlobal } from '../permission/modo-global'

/**
 * Ferramentas de delegação:
 * - subagent: worker efêmero em background (modo Subagents) — roda uma geração
 *   isolada com o modelo worker e devolve o texto como tool-result.
 * - create_task: registra tarefas do plano (usada apenas pelo OrchestratorEngine
 *   na fase de planejamento do modo Orchestra).
 */

const SUBAGENT_MAX_STEPS = 25

function newTaskId() {
  return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * `maxSteps` limita o trabalho de CADA subagente. Durante o PLANEJAMENTO da
 * orquestração a pesquisa deve ser leve (o objetivo é embasar a divisão, não
 * resolver a tarefa), então o orquestrador passa um teto baixo.
 *
 * `maxCalls` limita QUANTAS VEZES o modelo pode chamar esta tool no total —
 * sem isso, um texto de prompt pedindo "no máximo 2-3 chamadas" é só uma
 * sugestão que o modelo pode ignorar (era o que acontecia: 17 chamadas só
 * para planejar). Passado o limite, a tool recusa em vez de rodar mais um
 * subagente completo (que sozinho já custa vários passos e tokens).
 */
export function createSubagentTool(
  input: SendMessageInput,
  ctx: ToolContext | null,
  maxSteps = SUBAGENT_MAX_STEPS,
  maxCalls?: number,
) {
  let calls = 0
  return tool({
    description:
      'Delegates a subtask to a worker that runs in the background and returns the result as text. Use for parallel or isolated work: research, file analysis, focused tasks. The worker does not see this conversation — include all necessary context in the task.',
    inputSchema: z.object({
      task: z.string().describe('Self-contained task description, with all necessary context'),
      research: z.boolean().optional().describe('Enables web search (websearch/webfetch)'),
      browser: z.boolean().optional().describe('Enables JavaScript browser navigation'),
      code: z.boolean().optional().describe('Code mode: access to the working folder\'s files'),
      brain: z.boolean().optional().describe('Enables persistent memory (memory_* tools)'),
      simple: z.boolean().optional().describe('Plain text answers, no formatting'),
    }),
    execute: async ({ task, research, browser, code, brain, simple }) => {
      calls++
      if (maxCalls !== undefined && calls > maxCalls) {
        return `Limit of ${maxCalls} subagent calls reached — proceed with what has been gathered so far (do not request more research).`
      }
      const worker = input.workerModel ?? { providerId: input.providerId, modelId: input.modelId }
      const codeUnavailable = code === true && !input.directory
      const workerInput: SendMessageInput = {
        // ID sintético: isola o browser nativo do worker do da sessão principal
        sessionId: `${input.sessionId}-sub-${newTaskId()}`,
        text: task,
        providerId: worker.providerId,
        modelId: worker.modelId,
        mode: code && input.directory ? 'code' : 'chat',
        options: {
          research,
          browser,
          brain: brain ?? true,
          simple: simple ?? true,
          reasoning: worker.reasoning,
          // Gatekeeping: worker herda o modo de permissões do pai — e, se o
          // pai segue o seletor global, a troca no meio vale para ele também
          permissionMode: input.options.permissionMode,
          followGlobalPermission: input.options.followGlobalPermission,
        },
        directory: input.directory,
        extraDirectories: input.extraDirectories,
        orchestrationRole: 'worker',
        parentSessionId: input.sessionId,
        workerTitle: task.split('\n')[0].trim().slice(0, 60) || 'subagente',
        language: input.language,
      }

      const workerCtx: ToolContext | null =
        workerInput.mode === 'code' && ctx
          ? { ...ctx, sessionId: workerInput.sessionId }
          : null

      const model = await resolveModel(worker.providerId, worker.modelId)
      // provider do worker p/ reaplicar o interleave de reasoning (DeepSeek)
      // a cada passo do tool loop — o mesmo prepareStep do agente principal.
      const workerProvider = await getProvider(worker.providerId)
      const tools = buildToolSet(workerInput, workerCtx)
      const modoWorker = workerInput.options.permissionMode ?? 'ask'
      const toolApproval = createToolApproval(
        workerInput.options.followGlobalPermission ? () => modoGlobal(modoWorker) : modoWorker,
        workerInput.sessionId,
        ctx?.directory ?? null,
        workerInput.sessionId,
        ctx?.abort,
        workerInput.parentSessionId,
        workerInput.workerTitle,
      )

      const result = await generateText({
        model,
        system: await buildSystemPrompt(workerInput),
        prompt: task,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        toolApproval,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: ctx?.abort,
        providerOptions: await buildProviderOptions(workerInput),
        prepareStep: reasoningPrepareStep(workerProvider, worker.modelId),
      })
      const notice = codeUnavailable ? `${SUBAGENT_NO_FOLDER_NOTICE}\n\n` : ''
      return notice + (result.text || SUBAGENT_EMPTY_OUTPUT)
    },
  })
}

export interface CreateTaskArgs {
  title: string
  prompt: string
  research?: boolean
  browser?: boolean
  readonly?: boolean
  simple?: boolean
  vision?: boolean
  subagents?: boolean
  dependsOn?: string[]
}

/**
 * Teto de modos: o que a sessão do usuário permite. O orquestrador escolhe
 * DENTRO disso — pedir acima do teto não falha, é rebaixado com aviso no
 * resultado da tool (o modelo precisa saber que não recebeu o que pediu).
 */
export interface TaskModeCeiling {
  research: boolean
  browser: boolean
  vision: boolean
  subagents: boolean
}

/** Tool de planejamento do orquestrador: cada chamada vira uma OrchestrationTask. */
export function createTaskTool(
  register: (task: OrchestrationTask) => boolean,
  ceiling: TaskModeCeiling,
  /** O título já é de outro worker (deste plano ou de um anterior)? Na
   *  sidebar o título é a única coisa que separa um worker do outro. */
  titleTaken: (title: string) => boolean = () => false,
  /** Id de uma tarefa JÁ registrada neste plano, pelo título (dependsOn). */
  taskIdByTitle: (title: string) => string | undefined = () => undefined,
) {
  return tool({
    description: [
      'Registers a subtask in the orchestration plan. Each task becomes an independent worker session',
      'running in the working folder, in parallel, with no access to this conversation.',
      'Choose the modes each worker needs — they are not free: research and browser add latency,',
      'subagents multiply cost. Enable only what the task actually requires.',
    ].join(' '),
    inputSchema: z.object({
      title: z.string().describe(
        'Worker name shown in the sidebar, in the user\'s language. 2-5 words naming the concrete area or deliverable, '
        + 'so the user tells workers apart at a glance — e.g. "Webhook de pagamentos", "Tela de login: validação", "Testes do parser CSV". '
        + 'Never generic ("Implementação", "Análise", "Tarefa 1", "Backend") and never the same as another worker.',
      ),
      prompt: z.string().describe('Self-contained prompt for the worker, with all necessary context'),
      research: z.boolean().optional().describe('Web search — only if the task needs information from the internet'),
      browser: z.boolean().optional().describe('JavaScript browser — only to open/test real web pages'),
      readonly: z.boolean().optional().describe('Worker reads and analyses but never edits files or runs commands'),
      simple: z.boolean().optional().describe('Direct answers with no formatting. Good for short lookups, bad for specs and documentation'),
      vision: z.boolean().optional().describe('Lets the worker describe attached images'),
      subagents: z.boolean().optional().describe('Lets the worker delegate to its own background subagents. Costly — only for broad tasks'),
      dependsOn: z
        .array(z.string())
        .optional()
        .describe('Titles of tasks ALREADY registered in this plan that must be accepted before this one starts. Only for real order (tests after the feature, integration after its parts).'),
    }),
    execute: async ({ title, prompt, research, browser, readonly: readOnly, simple, vision, subagents, dependsOn }: CreateTaskArgs) => {
      // Dependência só de tarefa já registrada: além de dar o id, isso torna
      // ciclo impossível (ninguém depende de quem ainda não existe).
      const dependeDe: string[] = []
      for (const titulo of dependsOn ?? []) {
        const id = taskIdByTitle(titulo)
        if (!id) {
          return `Task "${title}" was NOT registered: "${titulo}" is not a task already registered in this plan. Register the prerequisites first and try again, using the exact title in dependsOn.`
        }
        if (!dependeDe.includes(id)) dependeDe.push(id)
      }
      if (titleTaken(title)) {
        return `A worker named "${title}" already exists in this conversation — the task was NOT registered. Call create_task again with a title that sets it apart (the specific area or deliverable), or use message_worker if the work continues that worker's.`
      }
      // Rebaixa o que passa do teto e conta para avisar o modelo.
      const denied: string[] = []
      const clamp = (want: boolean | undefined, allowed: boolean, name: string) => {
        if (want && !allowed) {
          denied.push(name)
          return undefined
        }
        return want
      }
      const accepted = register({
        id: newTaskId(),
        title,
        prompt,
        options: {
          research: clamp(research, ceiling.research, 'research'),
          browser: clamp(browser, ceiling.browser, 'browser'),
          plan: readOnly,
          simple,
          subagents: clamp(subagents, ceiling.subagents, 'subagents'),
        },
        vision: clamp(vision, ceiling.vision, 'vision'),
        status: 'idle',
        ...(dependeDe.length > 0 ? { dependeDe } : {}),
      })
      if (!accepted) return 'Plan task limit reached — do not register more tasks.'
      if (denied.length > 0) {
        return `Task "${title}" registered, but without ${denied.join(', ')}: the user did not enable ${denied.length > 1 ? 'those modes' : 'that mode'} in this conversation. Adjust the task prompt if it depended on it.`
      }
      return `Task "${title}" registered in the plan.`
    },
  })
}
