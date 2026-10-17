import type { ImageResult } from './types'

/**
 * Os resultados da última busca, por id. O agente escolhe pelo id curto
 * (`wc:123`, `ov:<uuid>`) e a importação precisa do endereço e do crédito: manter
 * isso aqui evita que o MODELO digite URL e licença — que é onde um erro de
 * transcrição faria uma imagem entrar com o crédito errado.
 */

const TTL_MS = 2 * 60 * 60 * 1000
const MAX_ENTRIES = 600

const entries = new Map<string, { result: ImageResult; at: number }>()

export function rememberResults(results: ImageResult[], now = Date.now()): void {
  for (const result of results) {
    entries.delete(result.id)
    entries.set(result.id, { result, at: now })
  }
  // O mais antigo sai primeiro (o Map guarda a ordem de inserção).
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function recallResult(id: string, now = Date.now()): ImageResult | null {
  const hit = entries.get(id.trim())
  if (!hit) return null
  if (now - hit.at > TTL_MS) {
    entries.delete(id.trim())
    return null
  }
  return hit.result
}

export function clearResultCache(): void {
  entries.clear()
}
