import type { ModelInput, VariantMap, VariantPayload } from './types'

/**
 * Options mínimas para tarefas auxiliares (título, compaction) — usa a
 * variant mais leve do modelo, equivalente ao smallOptions() do opencode.
 */
export function buildSmallOptions(model: ModelInput, variants: VariantMap): VariantPayload {
  const first = Object.values(variants)[0] ?? {}

  if (model.npm === '@ai-sdk/openai' || model.npm === '@ai-sdk/azure') {
    return { ...first, store: false }
  }

  return first
}
