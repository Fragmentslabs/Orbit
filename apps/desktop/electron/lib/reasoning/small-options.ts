import type { ModelInput, VariantMap, VariantPayload } from './types'

/**
 * Minimal options for auxiliary tasks (title, compaction) — uses the
 * lightest variant of the model.
 */
export function buildSmallOptions(model: ModelInput, variants: VariantMap): VariantPayload {
  const first = Object.values(variants)[0] ?? {}

  if (model.npm === '@ai-sdk/openai' || model.npm === '@ai-sdk/azure') {
    return { ...first, store: false }
  }

  return first
}
