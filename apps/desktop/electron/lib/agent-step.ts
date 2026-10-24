import type { ModelMessage } from 'ai'
import type { CatalogProvider } from '@shared/chat'
import { findCatalogModel } from '@shared/chat'
import { contextBudget, createTrimState, trimTurnContext, workingBudget } from './context-budget'
import { supportsAnthropicCache, withAnthropicCache } from './prompt-cache'
import { modelRuntime } from './provider-npm'
import { interleavedReasoningField, normalizeMessages } from './reasoning'

/**
 * O que todo tool loop faz antes de cada passo — o agente principal
 * (chat-engine), os subagentes, o orquestrador, o /init, o computer_task e a
 * esteira. Não passam pelo runChat porque ele é um turno de conversa inteiro
 * (persiste mensagens, emite eventos de tela, tira snapshot, compacta); o que
 * eles compartilham é só isto:
 *
 * 1. Corte do acúmulo do turno (context-budget.ts), com memória entre os
 *    passos para o prefixo ficar estável entre os cortes.
 * 2. Normalização de reasoning: o SDK reconstrói as mensagens entre steps e
 *    pode descartar o reasoning_content vazio de uma chamada de tool (DeepSeek
 *    exige o campo de volta em TODAS as mensagens de assistente, senão 400).
 *    Sem o campo interleaved ela ainda sanitiza mensagens de tool, evitando o
 *    crash do conversor openai-compatible em parts malformadas.
 * 3. Marcas de cache da Anthropic (prompt-cache.ts), quando o modelo fala esse
 *    protocolo.
 *
 * Chamada de um passo só (título, visão, revisão, mensagem de commit) fica de
 * fora de propósito: não há passo seguinte para reler o cache, e a escrita
 * nele custa 25% a mais que o input normal.
 */
export interface StepPreparer {
  /** As mensagens prontas para o passo — a MESMA referência quando nada mudou. */
  prepare(messages: ModelMessage[]): ModelMessage[]
  /** Resultados de tool descartados até aqui neste loop */
  readonly dropped: number
  readonly budget: number
  readonly workingBudget: number
}

export function createStepPreparer(
  provider: CatalogProvider | undefined,
  modelId: string,
  options: { directory?: string } = {},
): StepPreparer {
  const model = provider && findCatalogModel({ [provider.id]: provider }, provider.id, modelId)?.model
  const field = interleavedReasoningField(provider, modelId)
  const cache = supportsAnthropicCache(modelRuntime(provider, model).npm)
  const budget = contextBudget(model)
  const working = workingBudget(model)
  const state = createTrimState()
  return {
    prepare(messages) {
      const trimmed = trimTurnContext(messages, budget, { softBudget: working, state, directory: options.directory })
      const normalized = normalizeMessages(trimmed, field)
      return cache ? withAnthropicCache(normalized) : normalized
    },
    get dropped() {
      return state.dropped.size
    },
    budget,
    workingBudget: working,
  }
}

/** O preparador já no formato do `prepareStep` do SDK. Um por chamada de
 *  streamText/generateText: a memória do corte é do loop, não do processo. */
export function agentPrepareStep(
  provider: CatalogProvider | undefined,
  modelId: string,
  options: { directory?: string } = {},
): ({ messages }: { messages: ModelMessage[] }) => { messages?: ModelMessage[] } | Record<string, never> {
  const preparer = createStepPreparer(provider, modelId, options)
  return ({ messages }) => {
    const prepared = preparer.prepare(messages)
    return prepared === messages ? {} : { messages: prepared }
  }
}
