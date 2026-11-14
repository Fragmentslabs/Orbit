import type { PeerGrants } from '@shared/peers'

/**
 * What each kind of connected client is sent without asking — one table for the
 * phone and for another desktop, so a rule is never written twice.
 *
 * - `work`: routines and pipeline events.
 * - `memory`: changes in the Memories page of this machine (never the phone).
 * - `sync`: the settings mirrors (models, modes, tools, prefs, queue, rotation…).
 * - `notify`: pending asks and new-message notifications.
 *
 * The phone is the owner's own device and gets everything but `memory`. A desktop
 * gets all four only when paired with full control, since it then shows the same
 * screens; a view-only desktop never asks for them, so it receives none.
 */
export type SyncChannel = 'work' | 'memory' | 'sync' | 'notify'

export interface ClientCapabilityTarget {
  kind: 'phone' | 'desktop' | (string & {})
  grants?: Pick<PeerGrants, 'control'> | { control?: boolean }
}

function hasControl(client: ClientCapabilityTarget): boolean {
  return client.kind === 'desktop' && client.grants?.control === true
}

export function receivesChannel(client: ClientCapabilityTarget, channel: SyncChannel): boolean {
  if (hasControl(client)) return true
  return client.kind === 'phone' && channel !== 'memory'
}

/** Routines and pipeline. */
export const receivesWorkEvents = (client: ClientCapabilityTarget): boolean => receivesChannel(client, 'work')
/** Memories page. */
export const receivesMemoryEvents = (client: ClientCapabilityTarget): boolean => receivesChannel(client, 'memory')
/** Session/prefs/queue mirrors. */
export const receivesSyncEvents = (client: ClientCapabilityTarget): boolean => receivesChannel(client, 'sync')
/** Pending-ask and new-message notifications. */
export const receivesNotifications = (client: ClientCapabilityTarget): boolean => receivesChannel(client, 'notify')
