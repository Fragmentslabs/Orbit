import type { JSONValue, LanguageModel } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import { findCatalogModel } from '@shared/chat'
import { getAppSettings } from './app-settings'
import { getMergedCatalog } from './catalog'
import { resolveModel } from './providers'
import { buildProviderOptions } from './reasoning'

/**
 * Modelo das tarefas auxiliares: título da conversa, compactação do histórico
 * e sugestão da próxima mensagem. Sem modelo auxiliar escolhido — ou com um que
 * não resolve (provedor desconectado, modelo fora do catálogo) —, vale o modelo
 * da própria conversa, que era o comportamento antes da opção existir.
 */

export interface AuxModel {
  model: LanguageModel
  providerOptions?: Record<string, Record<string, JSONValue>>
  /** true quando caiu no modelo da conversa */
  fallback: boolean
}

/** A compactação manda até ~30 mil tokens de transcrição (MAX_SUMMARY_INPUT_CHARS). */
export const MIN_COMPACTION_CONTEXT = 40_000

export async function resolveAuxModel(
  conversation: { providerId: string; modelId: string },
  opts: { sessionId?: string; minContext?: number } = {},
): Promise<AuxModel> {
  const { auxModel, auxReasoning } = getAppSettings()
  if (auxModel) {
    try {
      const catalog = await getMergedCatalog()
      const found = findCatalogModel(catalog, auxModel.providerId, auxModel.modelId)
      const fitsContext = !opts.minContext || (found?.model.limit?.context ?? 0) >= opts.minContext
      if (found && fitsContext) {
        const model = await resolveModel(auxModel.providerId, found.modelId, { sessionId: opts.sessionId })
        const providerOptions = auxReasoning?.enabled
          ? await buildProviderOptions({
              sessionId: opts.sessionId ?? 'aux',
              text: '',
              providerId: auxModel.providerId,
              modelId: found.modelId,
              mode: 'chat',
              options: { reasoning: auxReasoning },
            } satisfies SendMessageInput)
          : undefined
        return { model, providerOptions, fallback: false }
      }
    } catch (err) {
      console.warn('[aux-model] modelo auxiliar indisponível, usando o da conversa:', err)
    }
  }
  const model = await resolveModel(conversation.providerId, conversation.modelId, { sessionId: opts.sessionId })
  return { model, fallback: true }
}
