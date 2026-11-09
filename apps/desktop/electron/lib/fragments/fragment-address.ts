import { isIP } from 'node:net'

/**
 * Is this resolved address one a fragment must never reach through `orbit.http`? Loopback,
 * private, link-local, shared (CGNAT), unspecified and multicast ranges — Orbit's own
 * machine and the person's network are not the internet.
 */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isBlockedV4(address)
  if (kind === 6) return isBlockedV6(address.toLowerCase())
  return true
}

function isBlockedV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return a >= 224
}

function isBlockedV6(address: string): boolean {
  if (address === '::' || address === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) return isBlockedV4(mapped[1])
  // ::ffff:7f00:1 style (hex form of a mapped v4)
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16)
    const lo = parseInt(hexMapped[2], 16)
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  const first = parseInt(address.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  return (first & 0xff00) === 0xff00 // multicast
}
