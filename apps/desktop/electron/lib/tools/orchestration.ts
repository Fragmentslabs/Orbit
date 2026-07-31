import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import type { OrchestrationTask, SendMessageInput, SessionMode } from '@shared/chat'
import { createToolApproval } from '../permission'
import { buildSystemPrompt } from '../prompts'
import { resolveModel } from '../providers'
import { buildProviderOptions } from '../reasoning'
import type { ToolContext } from './context'
import { buildToolSet } from './index'

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
        return `Limite de ${maxCalls} chamadas de subagent atingido — prossiga com o que já foi levantado (não peça mais pesquisas).`
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
          // Gatekeeping: worker herda o modo de permissões do pai
          permissionMode: input.options.permissionMode,
        },
        directory: input.directory,
        extraDirectories: input.extraDirectories,
        orchestrationRole: 'worker',
        parentSessionId: input.sessionId,
        workerTitle: task.split('\n')[0].trim().slice(0, 60) || 'subagente',
      }

      const workerCtx: ToolContext | null =
        workerInput.mode === 'code' && ctx
          ? { ...ctx, sessionId: workerInput.sessionId }
          : null

      const model = await resolveModel(worker.providerId, worker.modelId)
      const tools = buildToolSet(workerInput, workerCtx)
      const toolApproval = createToolApproval(
        workerInput.options.permissionMode ?? 'ask',
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
      })
      const notice = codeUnavailable
        ? '[Aviso: não há pasta de trabalho nesta conversa — o subagente rodou em modo chat, sem acesso a arquivos.]\n\n'
        : ''
      return notice + (result.text || '(o subagente não retornou texto)')
    },
  })
}

export interface CreateTaskArgs {
  title: string
  prompt: string
  mode?: SessionMode
  research?: boolean
  browser?: boolean
  readonly?: boolean
  brain?: boolean
  simple?: boolean
}

/** Tool de planejamento do orquestrador: cada chamada vira uma OrchestrationTask. */
export function createTaskTool(
  register: (task: OrchestrationTask) => boolean,
  opts: { allowCode: boolean },
) {
  return tool({
    description:
      'Registers a subtask in the orchestration plan. Each task will be executed by an independent worker, in parallel, with no access to this conversation.',
    inputSchema: z.object({
      title: z.string().describe('Short task title (shown in the UI)'),
      prompt: z.string().describe('Self-contained prompt for the worker, with all necessary context'),
      mode: z.enum(['chat', 'code']).optional().describe('"code" to touch files/commands; default "chat"'),
      research: z.boolean().optional().describe('Enables web search for the worker'),
      browser: z.boolean().optional().describe('Enables JavaScript browser for the worker'),
      readonly: z.boolean().optional().describe('Read-only code worker (doesn\'t edit or execute)'),
      brain: z.boolean().optional().describe('Enables persistent memory (memory_* tools)'),
      simple: z.boolean().optional().describe('Plain text answers, no formatting'),
    }),
    execute: async ({ title, prompt, mode, research, browser, readonly: readOnly, brain, simple }: CreateTaskArgs) => {
      // Sem pasta de trabalho não existe worker de código — degrada para chat
      // avisando o modelo, em vez de falhar silenciosamente na execução
      const codeUnavailable = mode === 'code' && !opts.allowCode
      const accepted = register({
        id: newTaskId(),
        title,
        prompt,
        mode: codeUnavailable ? 'chat' : (mode ?? 'chat'),
        options: { research, browser, plan: readOnly, brain: brain ?? true, simple: simple ?? true },
        status: 'idle',
      })
      if (!accepted) return 'Limite de tarefas do plano atingido — não registre mais tarefas.'
      return codeUnavailable
        ? `Tarefa "${title}" registrada em modo chat: não há pasta de trabalho nesta conversa, então tarefas "code" não estão disponíveis.`
        : `Tarefa "${title}" registrada no plano.`
    },
  })
}
