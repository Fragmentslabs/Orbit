import type { JSONValue } from 'ai'
import type { CatalogModel } from '@shared/chat'

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
  /** Controles de reasoning que o models.dev declara para o modelo NESTE
   *  provedor. Ausente quando o catálogo não informa. */
  reasoningOptions?: CatalogModel['reasoning_options']
  /** URL base do provedor — identifica a Moonshot (Kimi) por trás de um id genérico */
  apiUrl?: string
}

/** Payload de providerOptions sem o namespace do SDK */
export type VariantPayload = Record<string, JSONValue>

/** Mapa de variant id → payload, ordenado do mais fraco ao mais forte */
export type VariantMap = Record<string, VariantPayload>
