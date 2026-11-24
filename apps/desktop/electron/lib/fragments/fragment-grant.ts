import type { FragmentManifest } from '@shared/fragments'
import { FRAGMENT_CAPABILITIES } from '@shared/fragments'
import { cancelAllFor } from './fragment-notify'
import { isFragmentUntrusted } from './fragment-provenance'
import { fragmentEvents, isFragmentId, setGrant } from './fragment-store'

/**
 * The ONLY place a capability is granted or revoked: a click of the person, on the desktop's tab or on
 * the phone. Both doors come through here, so the same rules hold on both:
 *  - an unknown id or capability grants nothing;
 *  - an imported fragment nobody reviewed cannot be granted anything yet (turning off is always fine);
 *  - revoking "notify" cancels what the fragment had scheduled, so the permission takes its consequences with it.
 * Returns the manifest afterwards, or null when nothing was done.
 */
export async function grantFragmentCapability(id: string, capability: string, on: boolean): Promise<FragmentManifest | null> {
  if (!isFragmentId(id)) return null
  const cap = FRAGMENT_CAPABILITIES.find((c) => c === capability)
  if (!cap) return null
  if (on === true && (await isFragmentUntrusted(id))) return null
  const manifest = await setGrant(id, cap, on === true)
  if (manifest && cap === 'notify' && on === false) await cancelAllFor(id)
  // Every open view (the desktop's tabs, the phones) reads the manifest again.
  if (manifest) fragmentEvents.emit('updated', { fragmentId: id, revision: manifest.revision })
  return manifest
}
