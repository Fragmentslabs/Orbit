/**
 * Classification of provider endpoints. None of this is persisted: "local" and
 * "remote" come from the URL itself. Storing a field on the provider would create data
 * that ages — whoever edits `localhost:11434` to a cloud gateway
 * would keep showing up as local until someone remembers to update the field.
 */

/** Hosts that resolve to the machine itself (loopback). */
const LOOPBACK_HOSTS = new Set(["localhost", "::1"])

/**
 * URL of a server running ON THIS computer. LAN (`192.168.x.x`, `mac.local`)
 * counts as remote on purpose: it is another machine, even if it is near.
 *
 * An invalid or missing URL returns `false` — it falls into the remote group, where the
 * problem is visible, instead of hiding among the local ones.
 */
export function isLocalEndpoint(api: string | undefined): boolean {
  if (!api) return false
  let host: string
  try {
    host = new URL(api).hostname.toLowerCase()
  } catch {
    return false
  }
  // The URL returns IPv6 inside brackets ("[::1]").
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  // "localhost." (trailing dot) is also loopback.
  const name = bare.endsWith(".") ? bare.slice(0, -1) : bare

  if (LOOPBACK_HOSTS.has(name)) return true
  // The whole 127.0.0.0/8 is loopback, not only 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true
  // By specification, any "*.<something>localhost" points to loopback.
  return name.endsWith(".localhost")
}
