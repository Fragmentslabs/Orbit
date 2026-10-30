import type { CatalogModel, CatalogProvider } from '@shared/chat'

/**
 * Package the runtime uses to talk to a provider. In the catalog whoever decides
 * is models.dev's `npm`; in a custom provider (which models.dev does not
 * know) whoever decides is the `protocol` chosen in the registration. With neither of the
 * two, it falls back to the openai-compatible adapter — the same fallback as before.
 *
 * It lives in a module of its own (without app imports) because catalog.ts, providers.ts
 * and reasoning/index.ts need the SAME answer: if reasoning thought the provider
 * spoke openai-compatible while the runtime uses the Anthropic SDK,
 * the providerOptions would go out in the wrong namespace and the reasoning level would
 * get lost silently.
 */
export function providerRuntimeNpm(
  provider: Pick<CatalogProvider, 'npm' | 'protocol'> | undefined,
): string {
  if (provider?.npm) return provider.npm
  switch (provider?.protocol) {
    case 'anthropic-messages':
      return '@ai-sdk/anthropic'
    case 'openai-responses':
      return '@ai-sdk/openai'
    default:
      return '@ai-sdk/openai-compatible'
  }
}

/**
 * Package and endpoint of a MODEL. models.dev may swap both per model
 * (`model.provider`): in OpenCode Go the provider declares openai-compatible, but
 * Claude Haiku only exists in /go/anthropic/v1 through the Anthropic protocol — through the
 * OpenAI endpoint the gateway answers "Model does not support this protocol.".
 * Without a model, or without the override, the provider's counts.
 */
export function modelRuntime(
  provider: Pick<CatalogProvider, 'npm' | 'protocol' | 'api'> | undefined,
  model?: Pick<CatalogModel, 'provider'>,
): { npm: string; api?: string } {
  return {
    npm: model?.provider?.npm ?? providerRuntimeNpm(provider),
    api: model?.provider?.api ?? provider?.api,
  }
}
