import type { TLSSocket } from 'node:tls'
import type { PeerIdentity } from './identity'
import { normalizeFingerprint } from './pairing'

/**
 * TLS options of both ends, in one place so the server and the client agree.
 *
 * - Server: presents its certificate and REQUESTS the client's one. It does not
 *   reject an unknown client certificate at the TLS layer (a machine that is pairing
 *   for the first time has one nobody knows yet); the application layer then checks
 *   the fingerprint against the paired device before any data is served.
 * - Client, pinned: the only trusted CA is the peer's own certificate, and the hostname
 *   check is skipped (the address changes with DHCP; the certificate is the identity).
 * - Client, first contact (pairing): it accepts any certificate, records its
 *   fingerprint, and the pairing code — derived from both fingerprints — is what
 *   the people compare.
 */

export function serverTlsOptions(identity: PeerIdentity) {
  return {
    key: identity.key,
    cert: identity.cert,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3' as const,
  }
}

export function pinnedClientTlsOptions(identity: PeerIdentity, pinnedCert: string) {
  return {
    key: identity.key,
    cert: identity.cert,
    ca: [pinnedCert],
    rejectUnauthorized: true,
    // Node expects `Error | undefined`; ws types it as boolean. Either way, returning
    // nothing means "accepted" — the pinned CA above is the whole check.
    checkServerIdentity: (() => undefined) as never,
    minVersion: 'TLSv1.3' as const,
  }
}

export function firstContactClientTlsOptions(identity: PeerIdentity) {
  return {
    key: identity.key,
    cert: identity.cert,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3' as const,
  }
}

/** Fingerprint of the certificate the other end presented, or null when it presented none. */
export function remoteFingerprint(socket: TLSSocket): string | null {
  const cert = socket.getPeerCertificate()
  if (!cert || !('fingerprint256' in cert) || !cert.fingerprint256) return null
  return cert.fingerprint256
}

/** PEM of the certificate the other end presented (what the client pins after pairing). */
export function remoteCertificatePem(socket: TLSSocket): string | null {
  const cert = socket.getPeerCertificate()
  if (!cert || !('raw' in cert) || !cert.raw) return null
  const b64 = cert.raw.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
}

export function sameFingerprint(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizeFingerprint(a) === normalizeFingerprint(b)
}
