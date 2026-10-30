import type { JSONValue } from 'ai'
import type { CatalogModel } from '@shared/chat'

/**
 * Internal types of the reasoning module — isolated from shared/ so that the
 * variants logic does not depend on the IPC types.
 */

export interface ModelInput {
  providerId: string
  modelId: string
  /** SDK npm package (e.g. '@ai-sdk/openai') */
  npm: string
  /** ID used in the provider API (e.g. 'gpt-5') */
  apiId: string
  /** ISO release date (yyyy-mm-dd) — empty when unknown */
  releaseDate: string
  reasoning: boolean
  limit: { context: number; output: number }
  /** Reasoning controls that models.dev declares for the model on THIS
   *  provider. Absent when the catalog does not report it. */
  reasoningOptions?: CatalogModel['reasoning_options']
  /** Provider base URL — identifies Moonshot (Kimi) behind a generic id */
  apiUrl?: string
}

/** providerOptions payload without the SDK namespace */
export type VariantPayload = Record<string, JSONValue>

/** Map of variant id → payload, ordered from the weakest to the strongest */
export type VariantMap = Record<string, VariantPayload>
