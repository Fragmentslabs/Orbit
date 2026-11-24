import { FRAGMENT_CAPABILITIES, type FragmentCapability, type FragmentPhoneEntry } from '@orbit/shared'

/**
 * What a fragment asks for and what the person has allowed, as the phone words it. The grants
 * themselves are the desktop's (`fragments:grant` runs the same function as the desktop tab's Allow):
 * this only decides what to SHOW. The microphone is the one the phone cannot give a page, so it is
 * listed but never asked for here.
 */

/** Capabilities a fragment can use on the phone. */
export function phoneCapabilities(): FragmentCapability[] {
  return FRAGMENT_CAPABILITIES.filter((c) => c !== 'microphone')
}

/** The first capability the fragment wants and the person has not allowed: one ask at a time. */
export function pendingCapability(entry: Pick<FragmentPhoneEntry, 'requests' | 'grants'>): FragmentCapability | null {
  return phoneCapabilities().find((c) => entry.requests.includes(c) && !entry.grants.includes(c)) ?? null
}

/** What "internet" or "MCP" would reach, in words to check before allowing; empty for the others. */
export function describeAccess(entry: Pick<FragmentPhoneEntry, 'hosts' | 'mcp'>, capability: FragmentCapability): string {
  if (capability === 'http') return entry.hosts.join(', ')
  if (capability === 'mcp') return entry.mcp.map((m) => `${m.server} (${m.tools.join(', ')})`).join('; ')
  return ''
}

export interface CapabilityRow {
  capability: FragmentCapability
  granted: boolean
  /** The microphone: shown, not switchable here. */
  desktopOnly: boolean
  /** An unreviewed import cannot be switched ON (off is always possible). */
  locked: boolean
  access: string
}

/** One row per capability the fragment asked for, in the desktop's order. */
export function capabilityRows(entry: FragmentPhoneEntry): CapabilityRow[] {
  return FRAGMENT_CAPABILITIES.filter((c) => entry.requests.includes(c)).map((capability) => {
    const granted = entry.grants.includes(capability)
    return {
      capability,
      granted,
      desktopOnly: capability === 'microphone',
      locked: entry.untrusted && !granted,
      access: describeAccess(entry, capability),
    }
  })
}
