import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import forge from 'node-forge'
import { isPeerId } from '@shared/peers'

/**
 * Identity of this install for the peer server: a stable `peerId` and a
 * self-signed certificate (RSA 2048, SHA-256, 20 years).
 *
 * The certificate is the real identity — the `peerId` is only a handle for the UI and
 * the registry. Both sides use it in the mutual-TLS handshake: the server presents it,
 * and the client presents its own as the client certificate. After pairing, each
 * side keeps the other's certificate and trusts nothing else for that peer.
 *
 * No Electron here (the folder comes in as a parameter), so the TLS round trip is tested
 * with real sockets.
 */

export interface PeerIdentity {
  peerId: string
  /** PKCS#8 PEM. Never leaves this machine. */
  key: string
  cert: string
  /** SHA-256 of the DER, `AA:BB:…` (the same format as `getPeerCertificate().fingerprint256`). */
  fingerprint: string
}

interface StoredIdentity {
  peerId: string
  key: string
  cert: string
}

export function newPeerId(): string {
  return `p_${randomBytes(8).toString('hex')}`
}

export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256
}

export function generateIdentity(peerId: string = newPeerId()): PeerIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey)
  // Positive serial (the first bit clear), 16 bytes.
  cert.serialNumber = `0${randomBytes(15).toString('hex')}`
  const now = Date.now()
  cert.validity.notBefore = new Date(now - 24 * 60 * 60 * 1000)
  cert.validity.notAfter = new Date(now + 20 * 365 * 24 * 60 * 60 * 1000)
  const attrs = [
    { name: 'commonName', value: `Orbit ${peerId}` },
    { name: 'organizationName', value: 'Orbit' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  // CA:true so the certificate can be the trust anchor of itself: the client pins it
  // by passing it as the only `ca`, and OpenSSL then verifies the chain [this cert].
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
  ])
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create())
  const certPem = forge.pki.certificateToPem(cert)
  return { peerId, key: privateKey, cert: certPem, fingerprint: fingerprintOf(certPem) }
}

/** Reads `<dir>/peer-identity.json`, creating it (mode 0600) the first time. */
export function loadOrCreateIdentity(dir: string): PeerIdentity {
  const file = path.join(dir, 'peer-identity.json')
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredIdentity
    if (isPeerId(stored.peerId) && stored.key && stored.cert) {
      return { ...stored, fingerprint: fingerprintOf(stored.cert) }
    }
  } catch {
    /* first run, or a broken file — a new identity below */
  }
  const identity = generateIdentity()
  fs.mkdirSync(dir, { recursive: true })
  const stored: StoredIdentity = { peerId: identity.peerId, key: identity.key, cert: identity.cert }
  fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 })
  return identity
}
