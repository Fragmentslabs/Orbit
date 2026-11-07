import type { FragmentModelOption } from '@shared/fragments'
import { listCredentialProviders } from '../auth'
import { getMergedCatalog } from '../catalog'
import { listCustomProviders } from '../custom-providers'

/**
 * The models a fragment's own UI may offer for `orbit.ai` (`orbit.models`).
 *
 * Only models of providers the person has actually connected, and only ones that produce
 * text — the same set the app's model picker offers. The fragment gets names to show and
 * ids to send back; the broker re-checks every id it receives against this list, so a page
 * cannot select a provider the person never connected.
 */

const MAX_OPTIONS = 300

export async function listUsableModels(): Promise<FragmentModelOption[]> {
  const [catalog, credentials, custom] = await Promise.all([getMergedCatalog(), listCredentialProviders(), listCustomProviders()])
  const connected = new Set([...credentials, ...custom.filter((p) => Object.keys(p.models).length > 0).map((p) => p.id)])
  const options: FragmentModelOption[] = []
  for (const provider of Object.values(catalog)) {
    if (!connected.has(provider.id)) continue
    for (const model of Object.values(provider.models)) {
      if (model.status === 'deprecated') continue
      if (model.modalities && !model.modalities.output.includes('text')) continue
      options.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        name: model.name,
        reasoning: model.reasoning,
      })
      if (options.length >= MAX_OPTIONS) return options
    }
  }
  return options
}

export async function isUsableModel(providerId: unknown, modelId: unknown): Promise<boolean> {
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return false
  return (await listUsableModels()).some((m) => m.providerId === providerId && m.modelId === modelId)
}
