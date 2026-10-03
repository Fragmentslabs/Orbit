import type { JSONValue } from 'ai'

/**
 * Tipos internos do módulo de reasoning — isolados de shared/ para que a
 * lógica de variants não dependa dos tipos de IPC.
 */

export interface ModelInput {
  providerId: string
  modelId: string
  /** Pacote npm do SDK (ex: '@ai-sdk/openai') */
  npm: string
  /** ID usado na API do provedor (ex: 'gpt-5') */
  apiId: string
  /** Data de lançamento ISO (yyyy-mm-dd) — vazio quando desconhecida */
  releaseDate: string
  reasoning: boolean
  limit: { context: number; output: number }
  /** Níveis que o models.dev declara para o modelo (reasoning_options →
   *  effort). Ausente quando o catálogo não informa. */
  efforts?: string[]
  /** O catálogo declara só liga/desliga (reasoning_options sem `effort` nem
   *  `budget_tokens`): o provedor não aceita níveis. */
  toggleOnly?: boolean
}

/** Payload de providerOptions sem o namespace do SDK */
export type VariantPayload = Record<string, JSONValue>

/** Mapa de variant id → payload, ordenado do mais fraco ao mais forte */
export type VariantMap = Record<string, VariantPayload>
