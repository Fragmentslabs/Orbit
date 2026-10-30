/**
 * Provider CONFIGURATION error — it is not a failure of the provider itself: unknown
 * provider, missing API key, SDK that Orbit does not bundle.
 *
 * It lives in a module of its own, without dependencies, because two layers need it
 * without knowing each other: providers.ts (which throws it) and errors.ts (which classifies
 * it as `provider-config`, so the UI can translate the explanation). Importing
 * providers.ts inside errors.ts would drag the AI SDKs along just because
 * of an `instanceof`.
 *
 * The `reason` exists so that the classification does not depend on matching the
 * message's text — the text is diagnostic and may change language; the reason does not.
 */
export type ProviderConfigReason = 'unknown-provider' | 'missing-key' | 'missing-sdk'

export class ProviderResolutionError extends Error {
  constructor(
    message: string,
    readonly reason: ProviderConfigReason,
  ) {
    super(message)
    this.name = 'ProviderResolutionError'
  }
}
