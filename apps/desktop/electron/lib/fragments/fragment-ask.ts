import type { FragmentCapability, FragmentManifest, FragmentPermissionAskEvent } from '@shared/fragments'
import { fragmentEvents, setRequested } from './fragment-store'

/**
 * The page tried to use a capability the person has not allowed yet.
 *
 * There is no separate window for this: the ask is the SAME one every other capability
 * uses — the notice above the fragment, driven by the manifest's `requests` without a
 * matching `grant`. So the attempt is enough to declare it (a fragment written before the
 * capability existed starts asking the moment it tries to use it), and the page's call keeps
 * failing until the person clicks Allow up there and calls again.
 */
export async function announceAsk(
  fragmentId: string,
  capability: FragmentCapability,
): Promise<FragmentManifest | null> {
  const manifest = await setRequested(fragmentId, capability, true)
  if (!manifest) return null
  fragmentEvents.emit('permission-ask', { fragmentId, capability } satisfies FragmentPermissionAskEvent)
  fragmentEvents.emit('updated', { fragmentId, revision: manifest.revision })
  return manifest
}
