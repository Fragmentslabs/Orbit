/**
 * The desktop identifies itself with the raw system `hostname()`, which on macOS comes
 * as "MacBook-Air-de-Desknik.local" and on Windows as "DESKTOP-4F2K9". Storing
 * the raw value is right (it is the real name of the machine on the network); what does not work is
 * showing it like that.
 *
 * Formats only on display: strips the mDNS suffix and swaps the separators for a space.
 */
export function prettyDeviceName(name?: string | null): string | undefined {
  if (!name) return undefined
  const withoutMdns = name.trim().replace(/\.local\.?$/i, '')
  const spaced = withoutMdns.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return spaced || undefined
}
