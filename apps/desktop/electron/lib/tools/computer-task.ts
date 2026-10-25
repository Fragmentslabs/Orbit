import { generateText, stepCountIs, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { getAppSettings } from '../app-settings'
import { getProvider, modelSupportsVision } from '../catalog'
import { createToolApproval } from '../permission'
import { modoGlobal } from '../permission/modo-global'
import { computerSubagentPrompt } from '../prompts'
import { resolveModel } from '../providers'
import { agentPrepareStep } from '../agent-step'
import { createComputerTools } from './computer'

/**
 * `computer_task` — subagente de Computer Use. O agente principal manda um
 * objetivo e espera; um agente dedicado roda o laço observar → agir com
 * contexto CURTO (só o objetivo e as próprias observações, nunca a conversa) e,
 * se configurado, um modelo menor e mais rápido. Cada passo fica mais leve: no
 * laço direto, cada clique reenviava a conversa inteira com os screenshots.
 *
 * As tools cu_* do subagente usam o MESMO sessionId da conversa: o registro de
 * observações, a faixa amarela, o chip, a miniatura do painel e uma gravação
 * em andamento enxergam o que ele faz. As permissões passam pelo mesmo gate
 * (o pedido aparece na conversa), e a denylist vale igual.
 */

const COMPUTER_TASK_MAX_STEPS = 40
/** Só o laço: gravação e permissões ficam com o agente principal. */
const SUBAGENT_TOOLS = ['cu_apps', 'cu_observe', 'cu_query', 'cu_computer', 'cu_batch']

export function createComputerTaskTool(input: SendMessageInput, abort?: AbortSignal) {
  return tool({
    description:
      'Delegates a multi-step task in another app of the user\'s computer to a dedicated computer-use agent, which runs the observe/act loop with a short context (and a faster model when configured) and returns a report. The agent does not see this conversation: give a self-contained goal — the app, what to do, what "done" looks like, and anything it must not do. Use it for flows of several actions; for one quick action use cu_computer yourself.',
    inputSchema: z.object({
      goal: z.string().describe('Self-contained goal: app, steps or outcome, constraints'),
    }),
    execute: async ({ goal }, { abortSignal }) => {
      const configured = getAppSettings().computer.model
      const target = configured ?? { providerId: input.providerId, modelId: input.modelId }
      const provider = await getProvider(target.providerId)
      const model = await resolveModel(target.providerId, target.modelId)
      const signal = abortSignal ?? abort
      const all = createComputerTools({
        sessionId: input.sessionId,
        modelVision: modelSupportsVision(provider, target.modelId),
        visionModel: input.visionModel,
      })
      const tools: ToolSet = Object.fromEntries(Object.entries(all).filter(([name]) => SUBAGENT_TOOLS.includes(name)))
      const mode = input.options.permissionMode ?? 'ask'
      // Gate próprio do subagente: os pedidos vão para a conversa (mesmo
      // sessionId), e "Permitir neste turno" vale pela execução dele.
      const toolApproval = createToolApproval(
        input.options.followGlobalPermission ? () => modoGlobal(mode) : mode,
        input.sessionId,
        input.directory ?? null,
        `${input.sessionId}-computer-task`,
        signal,
      )
      const started = Date.now()
      const result = await generateText({
        model,
        system: computerSubagentPrompt(input.language),
        prompt: goal,
        tools,
        toolApproval,
        stopWhen: stepCountIs(COMPUTER_TASK_MAX_STEPS),
        abortSignal: signal,
        prepareStep: agentPrepareStep(provider, target.modelId),
      })
      const actions = result.steps.flatMap((s) => s.toolCalls).length
      const seconds = Math.round((Date.now() - started) / 100) / 10
      const header = `Computer agent (${target.modelId}) finished in ${seconds}s with ${actions} tool call(s)${result.steps.length >= COMPUTER_TASK_MAX_STEPS ? ' — stopped at the step limit' : ''}.`
      return `${header}\n\n${result.text || '(no report — check the screen with cu_observe)'}`
    },
  })
}
