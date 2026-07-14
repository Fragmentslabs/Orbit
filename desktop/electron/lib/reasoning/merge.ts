import type { VariantPayload } from './types'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep merge de payloads de providerOptions (base → variant). Objetos são
 * mesclados recursivamente; arrays e primitivos são substituídos.
 */
export function mergeOptions(...sources: VariantPayload[]): VariantPayload {
  const result: VariantPayload = {}
  for (const source of sources) {
    for (const key in source) {
      const incoming = source[key]
      const current = result[key]
      if (isPlainObject(incoming) && isPlainObject(current)) {
        result[key] = mergeOptions(current as VariantPayload, incoming as VariantPayload)
      } else {
        result[key] = incoming
      }
    }
  }
  return result
}
