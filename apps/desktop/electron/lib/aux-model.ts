import type { JSONValue, LanguageModel } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import { findCatalogModel } from '@shared/chat'
import { getAppSettings } from './app-settings'
import { getMergedCatalog } from './catalog'
import { resolveModel } from './providers'
import { buildProviderOptions } from './reasoning'

/**
 * Model for the auxiliary tasks: conversation title, history compaction
 * and next-message suggestion. Without an auxiliary model chosen — or with one that
 * does not resolve (disconnected provider, model outside the catalog) —, the
 * conversation's own model counts, which was the behavior before the option existed.
 */

export interface AuxModel {
  model: LanguageModel
  providerOptions?: Record<string, Record<string, JSONValue>>
  /** true when it fell back to the conversation's model */
  fallback: boolean
}

/** Compaction sends up to ~30k tokens of transcript (MAX_SUMMARY_INPUT_CHARS). */
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
      console.warn('[aux-model] auxiliary model unavailable, using the conversation one:', err)
    }
  }
  const model = await resolveModel(conversation.providerId, conversation.modelId, { sessionId: opts.sessionId })
  return { model, fallback: true }
}
