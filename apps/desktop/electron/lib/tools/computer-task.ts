import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { findCatalogModel } from '@shared/chat'
import { getAppSettings } from '../app-settings'
import { getProvider, modelSupportsVision } from '../catalog'
import { findRecipe, recipeHint, saveRecipe } from '../computer/recipes'
import { assertCanControl } from '../computer/session'
import { createToolApproval } from '../permission'
import { modoGlobal } from '../permission/modo-global'
import { computerSubagentPrompt } from '../prompts'
import { resolveModel } from '../providers'
import { buildCheapestReasoningOptions } from '../reasoning'
import { agentPrepareStep } from '../agent-step'
import { createComputerTools } from './computer'

/**
 * `computer_task` — subagente de Computer Use. O agente principal manda um
 * objetivo e espera; um agente dedicado roda o laço observar → agir com
 * contexto CURTO (só o objetivo e as próprias observações, nunca a conversa) e
 * um modelo menor. Cada passo fica mais leve: no laço direto, cada clique
 * reenviava a conversa inteira.
 *
 * O modelo: o das Preferências → Computador; sem ele, o modelo auxiliar (se
 * chama tools); só então o da conversa. Raciocínio no menor nível que o
 * modelo aceita — cada passo é "clicar no que acabei de ver". Quando o laço
 * trava (ações que não mudam nada, erros seguidos), o passo seguinte sobe para
 * o modelo da conversa: o barato faz o caminho, o caro só entra no impasse.
 *
 * As tools cu_* do subagente usam o MESMO sessionId da conversa: o registro de
 * observações, a faixa amarela, o chip, a miniatura do painel e uma gravação
 * em andamento enxergam o que ele faz. As permissões passam pelo mesmo gate
 * (o pedido aparece na conversa), e a denylist vale igual.
 */

const COMPUTER_TASK_MAX_STEPS = 40
/** Só o laço: gravação e permissões ficam com o agente principal. */
const SUBAGENT_TOOLS = ['cu_apps', 'cu_observe', 'cu_query', 'cu_computer', 'cu_batch']
/** Resultados de erro seguidos até subir para o modelo da conversa. */
const ESCALATE_AFTER_ERRORS = 2

interface Target {
  providerId: string
  modelId: string
  source: 'settings' | 'aux' | 'conversation'
}

async function subagentTarget(input: SendMessageInput): Promise<Target> {
  const { computer, auxModel } = getAppSettings()
  if (computer.model) return { ...computer.model, source: 'settings' }
  if (auxModel) {
    const provider = await getProvider(auxModel.providerId).catch(() => undefined)
    const found = provider && findCatalogModel({ [provider.id]: provider }, provider.id, auxModel.modelId)
    // O auxiliar é escolhido para títulos e resumos: só serve aqui se chama tools.
    if (found?.model.tool_call) return { providerId: auxModel.providerId, modelId: found.modelId, source: 'aux' }
  }
  return { providerId: input.providerId, modelId: input.modelId, source: 'conversation' }
}

/** Texto de um resultado de tool (string, ou a parte de texto de um com imagem). */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && 'message' in output && typeof output.message === 'string') return output.message
  return ''
}

const isError = (text: string) => /^Error \(|STOPPED —|STOP: /m.test(text)

export function createComputerTaskTool(input: SendMessageInput, abort?: AbortSignal) {
  return tool({
    description:
      'Delegates a multi-step task in another app of the user\'s computer to a dedicated computer-use agent, which runs the observe/act loop with a short context and a faster model, and returns a report. The agent does not see this conversation: give a self-contained goal — the app, what to do, what "done" looks like, and anything it must not do. Use it for flows of several actions; for one quick action use cu_computer yourself, and to confirm its result use cu_verify instead of observing the whole window.',
    inputSchema: z.object({
      goal: z.string().describe('Self-contained goal: app, steps or outcome, constraints'),
    }),
    execute: async ({ goal }, { abortSignal }) => {
      // Outra conversa controlando: nem sobe o subagente (ele só bateria na
      // mesma trava a cada ação, gastando passos).
      try {
        assertCanControl(input.sessionId)
      } catch (err) {
        return `Error (busy): ${err instanceof Error ? err.message : String(err)} Do not retry: tell the user, and ask whether to wait for it or stop it (⌘⇧. stops it).`
      }
      const target = await subagentTarget(input)
      const provider = await getProvider(target.providerId)
      const model = await resolveModel(target.providerId, target.modelId)
      // O modelo da conversa, para o impasse. Igual ao do subagente, não há para onde subir.
      const sameAsConversation = target.providerId === input.providerId && target.modelId === input.modelId
      let strong: LanguageModel | null = null
      const signal = abortSignal ?? abort
      let stalled = false
      let escalatedAt: number | null = null
      const all = createComputerTools({
        sessionId: input.sessionId,
        modelVision: modelSupportsVision(provider, target.modelId),
        visionModel: input.visionModel,
        conversation: { providerId: input.providerId, modelId: input.modelId },
        onStall: () => {
          stalled = true
        },
      })
      const tools: ToolSet = Object.fromEntries(Object.entries(all).filter(([name]) => SUBAGENT_TOOLS.includes(name)))
      const mode = input.options.permissionMode ?? 'ask'
      // Gate próprio do subagente: os pedidos vão para a conversa (mesmo
      // sessionId), e "Permitir neste turno" vale pela execução dele.
      const toolApproval = createToolApproval(
        input.options.followGlobalPermission ? () => modoGlobal(input.sessionId, mode) : mode,
        input.sessionId,
        input.directory ?? null,
        `${input.sessionId}-computer-task`,
        signal,
      )
      const recipe = await findRecipe(goal).catch(() => null)
      const prompt = recipe ? `${goal}\n\n${recipeHint(recipe)}` : goal
      const trim = agentPrepareStep(provider, target.modelId)
      const started = Date.now()
      const result = await generateText({
        model,
        system: computerSubagentPrompt(input.language),
        prompt,
        tools,
        toolApproval,
        providerOptions: await buildCheapestReasoningOptions(target.providerId, target.modelId, input.sessionId),
        // Parar no impasse sem modelo para subir: o relatório volta ao agente
        // principal, que decide (ou pergunta) — melhor que gastar os 40 passos.
        stopWhen: [stepCountIs(COMPUTER_TASK_MAX_STEPS), () => stalled && (sameAsConversation || escalatedAt !== null)],
        abortSignal: signal,
        prepareStep: async ({ messages, steps }) => {
          const prepared = trim({ messages })
          if (sameAsConversation || escalatedAt !== null) return escalatedAt !== null && strong ? { ...prepared, model: strong } : prepared
          const recent = steps.slice(-ESCALATE_AFTER_ERRORS).flatMap((s) => s.toolResults.map((r) => resultText(r.output)))
          const stuck = stalled || (recent.length >= ESCALATE_AFTER_ERRORS && recent.every(isError))
          if (!stuck) return prepared
          strong ??= await resolveModel(input.providerId, input.modelId)
          escalatedAt = steps.length
          stalled = false
          return { ...prepared, model: strong }
        },
      })
      const calls = result.steps.flatMap((s) => s.toolCalls)
      const summaries = result.steps.flatMap((s) =>
        s.toolResults.filter((r) => r.toolName === 'cu_computer' || r.toolName === 'cu_batch').flatMap((r) => resultText(r.output).split('\n\nApp: ')[0].split('\n')),
      )
      const hitLimit = result.steps.length >= COMPUTER_TASK_MAX_STEPS
      // Só o que deu certo vira receita: um laço que travou ou bateu no teto
      // ensinaria o caminho errado na próxima vez.
      if (!hitLimit && !stalled && summaries.length > 0 && !summaries.some(isError)) {
        await saveRecipe(goal, summaries.map((line) => line.replace(/^\d+\. /, ''))).catch(() => undefined)
      }
      const usage = result.totalUsage
      const seconds = Math.round((Date.now() - started) / 100) / 10
      const tokens = `${usage.inputTokens ?? 0} in (${usage.inputTokenDetails?.cacheReadTokens ?? 0} cached) / ${usage.outputTokens ?? 0} out (${usage.outputTokenDetails?.reasoningTokens ?? 0} reasoning)`
      console.info(
        `[computer_task] ${target.modelId} (${target.source}) · ${seconds}s · ${result.steps.length} step(s) · ${calls.length} call(s) · ${tokens}${escalatedAt !== null ? ` · escalated at step ${escalatedAt}` : ''}${recipe ? ' · recipe' : ''}`,
      )
      const header = [
        `Computer agent (${target.modelId}) finished in ${seconds}s with ${calls.length} tool call(s), ${tokens} tokens`,
        escalatedAt !== null ? ` — moved to ${input.modelId} at step ${escalatedAt + 1} after getting stuck` : '',
        hitLimit ? ' — stopped at the step limit' : '',
        stalled ? ' — stopped: its actions were not changing the screen' : '',
        '.',
      ].join('')
      return `${header}\n\n${result.text || '(no report — check the result with cu_verify)'}`
    },
  })
}
