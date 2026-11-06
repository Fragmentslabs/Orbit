// Minimal typing of the node-forge API used to issue the self-signed
// certificate of the peer server (see identity.ts). The package ships no types.
declare module 'node-forge' {
  interface ForgeCertificate {
    publicKey: unknown
    serialNumber: string
    validity: { notBefore: Date; notAfter: Date }
    setSubject(attrs: { name: string; value: string }[]): void
    setIssuer(attrs: { name: string; value: string }[]): void
    setExtensions(exts: Record<string, unknown>[]): void
    sign(key: unknown, md: unknown): void
  }
  const forge: {
    pki: {
      createCertificate(): ForgeCertificate
      privateKeyFromPem(pem: string): unknown
      publicKeyFromPem(pem: string): unknown
      certificateToPem(cert: ForgeCertificate): string
    }
    md: { sha256: { create(): unknown } }
  }
  export default forge
}
