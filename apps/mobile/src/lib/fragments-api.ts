import type { FragmentCallResult, FragmentCapability, FragmentPhoneEntry } from '@orbit/shared'
import { offlineResult } from './fragments-bridge'
import { useConnectionStore } from '~/stores/connection-store'

/** Thin typed calls over the companion socket for the Fragments screens. */
async function call<T>(req: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await useConnectionStore.getState().wsClient.send(req as never)
    if (!res.ok) return { ok: false, error: res.error ?? 'request failed' }
    return { ok: true, data: res.data as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fragmentsList(): Promise<{ ok: true; data: FragmentPhoneEntry[] } | { ok: false; error: string }> {
  return call<FragmentPhoneEntry[]>({ type: 'fragments:list' })
}

/** Fixes (or releases) the fragment at the top of the list: one flag, shared with the desktop. */
export async function fragmentsPin(fragmentId: string, pinned: boolean): Promise<boolean> {
  return (await call<{ pinned: boolean }>({ type: 'fragments:pin', fragmentId, pinned })).ok
}

/** Deletes the fragment on the desktop (files, data, notifications). */
export async function fragmentsRemove(fragmentId: string): Promise<boolean> {
  return (await call<unknown>({ type: 'fragments:remove', fragmentId })).ok
}

/** The person's click on Allow (or the switch turned off): the desktop's own grant function decides. */
export async function fragmentsGrant(fragmentId: string, capability: FragmentCapability, on: boolean): Promise<FragmentCapability[] | null> {
  const res = await call<{ grants: FragmentCapability[] }>({ type: 'fragments:grant', fragmentId, capability, on })
  return res.ok ? res.data.grants : null
}

/** One `window.orbit` call of a fragment. The desktop's broker decides; a socket that failed is an answer too. */
export async function fragmentsCall(fragmentId: string, method: string, params?: unknown): Promise<FragmentCallResult> {
  const res = await call<FragmentCallResult>({ type: 'fragments:call', fragmentId, method, params })
  return res.ok ? res.data : offlineResult(res.error)
}
