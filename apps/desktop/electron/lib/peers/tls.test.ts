import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { WebSocket, WebSocketServer } from 'ws'
import { generateIdentity, type PeerIdentity } from './identity'
import {
  firstContactClientTlsOptions,
  pinnedClientTlsOptions,
  remoteCertificatePem,
  remoteFingerprint,
  sameFingerprint,
  serverTlsOptions,
} from './tls-options'
import { pairingCode } from './pairing'

/**
 * Real sockets: the pinning only protects anything if OpenSSL really refuses a
 * certificate other than the pinned one, and the server really sees the client's.
 */
describe('peer mutual TLS', () => {
  let server: PeerIdentity
  let client: PeerIdentity
  let stranger: PeerIdentity
  let httpsServer: https.Server
  let port = 0
  const seenClientFingerprints: (string | null)[] = []

  beforeAll(async () => {
    server = generateIdentity()
    client = generateIdentity()
    stranger = generateIdentity()
    httpsServer = https.createServer(serverTlsOptions(server), (req, res) => {
      seenClientFingerprints.push(remoteFingerprint(req.socket as TLSSocket))
      res.end('ok')
    })
    const wss = new WebSocketServer({ server: httpsServer })
    wss.on('connection', (ws, req) => {
      ws.send(remoteFingerprint(req.socket as TLSSocket) ?? 'none')
    })
    await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve))
    port = (httpsServer.address() as AddressInfo).port
  }, 30_000)

  afterAll(() => {
    httpsServer.close()
  })

  function wsOnce(options: Record<string, unknown>): Promise<{ message?: string; error?: Error; certPem?: string | null }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, options)
      let certPem: string | null | undefined
      ws.on('upgrade', (res) => {
        certPem = remoteCertificatePem(res.socket as TLSSocket)
      })
      ws.on('message', (data) => {
        resolve({ message: data.toString(), certPem })
        ws.close()
      })
      ws.on('error', (error) => resolve({ error }))
    })
  }

  it('a pinned client connects and the server sees its certificate', async () => {
    const result = await wsOnce(pinnedClientTlsOptions(client, server.cert))
    expect(result.error).toBeUndefined()
    expect(sameFingerprint(result.message, client.fingerprint)).toBe(true)
  })

  it('a client pinned to another certificate refuses the server', async () => {
    const result = await wsOnce(pinnedClientTlsOptions(client, stranger.cert))
    expect(result.error).toBeDefined()
    expect(result.message).toBeUndefined()
  })

  it('first contact reads the server certificate, which matches its fingerprint', async () => {
    const result = await wsOnce(firstContactClientTlsOptions(client))
    expect(result.error).toBeUndefined()
    expect(result.certPem).toBeTruthy()
    const pinnedAgain = await wsOnce(pinnedClientTlsOptions(client, result.certPem!))
    expect(pinnedAgain.error).toBeUndefined()
  })

  it('HTTPS with the pinned options works and carries the client certificate', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port, path: '/x', method: 'GET', ...pinnedClientTlsOptions(client, server.cert) },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => resolve(data))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(body).toBe('ok')
    expect(sameFingerprint(seenClientFingerprints.at(-1), client.fingerprint)).toBe(true)
  })

  it('a machine in the middle produces a different code on each side', () => {
    const nonces = { requesterNonce: 'a'.repeat(64), responderNonce: 'b'.repeat(64) }
    const honest = pairingCode({ requesterFingerprint: client.fingerprint, responderFingerprint: server.fingerprint, ...nonces })
    // The requester talks to the attacker (it sees the stranger's cert); the responder
    // sees the attacker's client cert (the stranger's too).
    const requesterSide = pairingCode({ requesterFingerprint: client.fingerprint, responderFingerprint: stranger.fingerprint, ...nonces })
    const responderSide = pairingCode({ requesterFingerprint: stranger.fingerprint, responderFingerprint: server.fingerprint, ...nonces })
    expect(honest).toMatch(/^\d{6}$/)
    expect(requesterSide).not.toBe(responderSide)
  })
})
