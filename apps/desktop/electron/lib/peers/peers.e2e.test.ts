import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Two "machines" in one process, over real sockets: pairing by the accept card,
 * the code on both sides, the desktop allowlist of the companion server, project
 * files, a media file through the pinned HTTPS proxy, and revoke.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-peers-e2e-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => tmp,
    getVersion: () => '0.0.0-test',
    getAppPath: () => tmp,
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { fetch: () => Promise.reject(new Error('no net')) },
  session: { fromPartition: () => ({ protocol: { handle: () => {} } }), defaultSession: {} },
  shell: {},
  dialog: {},
  nativeImage: { createFromBuffer: () => ({}) },
  Notification: class {},
  powerSaveBlocker: { start: () => 0, stop: () => {} },
  webContents: { getAllWebContents: () => [] },
  screen: {},
  clipboard: {},
}))

const wait = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('peers end to end', () => {
  const port = 41000 + Math.floor(Math.random() * 2000)
  let server: typeof import('./peer-server')
  let client: typeof import('./peer-client')
  let companion: typeof import('../companion-server')
  let identityMod: typeof import('./identity')
  let remoteIndex: typeof import('./remote-index')
  let remoteAssets: typeof import('./remote-assets')
  let storage: typeof import('../storage')
  let discoverable = true
  let peerId = ''

  beforeAll(async () => {
    identityMod = await import('./identity')
    server = await import('./peer-server')
    client = await import('./peer-client')
    companion = await import('../companion-server')
    remoteIndex = await import('./remote-index')
    remoteAssets = await import('./remote-assets')
    storage = await import('../storage')
    const b = identityMod.generateIdentity()
    const a = identityMod.generateIdentity()
    server.startPeerServer({ identity: b, port, selfName: () => 'Machine B', isDiscoverable: () => discoverable, onChange: () => {} })
    await client.initPeerClient({ identity: a, selfName: () => 'Machine A', hooks: { emit: () => {}, changed: () => {} } })
    await new Promise((r) => setTimeout(r, 200))
  }, 60_000)

  afterAll(() => {
    client?.cancelPairing()
    server?.stopPeerServer()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function pair(grants: { send: boolean; files: boolean }) {
    client.startPairing('127.0.0.1', port)
    await wait(() => server.listIncomingRequests().length === 1 && client.outgoingState()?.status === 'waiting')
    const incoming = server.listIncomingRequests()[0]
    // The same code on both screens.
    expect(client.outgoingState()?.code).toBe(incoming.code)
    expect(incoming.name).toBe('Machine A')
    expect(await server.acceptIncomingRequest(incoming.requestId, grants)).toBe(true)
    await wait(() => client.outgoingState()?.status === 'accepted')
    await wait(() => client.knownPeers().some((p) => p.online))
    peerId = client.knownPeers()[0].peerId
    client.cancelPairing()
  }

  it('refuses a pairing request while not discoverable', async () => {
    discoverable = false
    client.startPairing('127.0.0.1', port)
    await wait(() => client.outgoingState()?.status === 'declined')
    expect(client.outgoingState()?.reason).toBe('not_discoverable')
    client.cancelPairing()
    discoverable = true
  })

  it('pairs view-only and enforces the allowlist', async () => {
    await pair({ send: false, files: false })
    expect(client.knownPeers()[0].grants).toEqual({ send: false, files: false })
    expect(Array.isArray(await client.peerRequest(peerId, { type: 'sessions:list' }))).toBe(true)
    for (const type of ['messages:send', 'fs:tree', 'prefs:set', 'fs:list-dirs', 'memory:list', 'git:checkout', 'ask:reply', 'auth']) {
      await expect(client.peerRequest(peerId, { type, sessionId: 'x', text: 'hi' }), type).rejects.toThrow('forbidden')
    }
  }, 60_000)

  it('serves a media file only through the pinned connection', async () => {
    const mediaDir = path.join(tmp, 'orbit-data', 'media')
    fs.mkdirSync(mediaDir, { recursive: true })
    fs.writeFileSync(path.join(mediaDir, 'img_e2etest.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]))
    expect(await remoteAssets.fetchRemoteAsset('media', 'img_e2etest.png', '')).toBeNull()
    remoteIndex.rememberRemoteId('img_e2etest.png', peerId)
    const res = await remoteAssets.fetchRemoteAsset('media', 'img_e2etest.png', '')
    expect(res?.status).toBe(200)
    expect(Buffer.from(await res!.arrayBuffer())).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3]))

    // Without our client certificate and token the peer server answers nothing.
    const https = await import('node:https')
    const status = await new Promise<number>((resolve) => {
      https
        .get({ host: '127.0.0.1', port, path: '/peer/file/media/img_e2etest.png', rejectUnauthorized: false }, (r) => {
          r.resume()
          resolve(r.statusCode ?? 0)
        })
        .on('error', () => resolve(-1))
    })
    expect(status).toBe(401)
  }, 60_000)

  it('re-pairing with files lets it read the project, never the secrets', async () => {
    const project = path.join(tmp, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'readme.md'), '# hello')
    fs.writeFileSync(path.join(project, '.env'), 'TOKEN=1')
    await storage.writeJson('session/s_e2e', { id: 's_e2e', title: 'E2E', mode: 'code', directory: project, createdAt: 1, updatedAt: 1 })
    // One request per IP every 5 s: the pairing above came from the same address.
    await new Promise((r) => setTimeout(r, 5200))
    await pair({ send: false, files: true })
    const tree = await client.peerRequest<{ entries: { name: string }[] }>(peerId, { type: 'fs:tree', sessionId: 's_e2e', root: 0, path: '' })
    expect(tree.entries.map((e) => e.name)).toEqual(['readme.md'])
    const file = await client.peerRequest<{ content: string }>(peerId, { type: 'fs:read', sessionId: 's_e2e', root: 0, path: 'readme.md' })
    expect(file.content).toBe('# hello')
    await expect(client.peerRequest(peerId, { type: 'fs:read', sessionId: 's_e2e', root: 0, path: '.env' })).rejects.toThrow()
    await expect(client.peerRequest(peerId, { type: 'fs:read', sessionId: 's_e2e', root: 0, path: '../peer-identity.json' })).rejects.toThrow()
  }, 60_000)

  it('revoke closes the connection and the token stops working', async () => {
    const devices = await companion.listGrantedDevices()
    const desktop = devices.find((d) => d.kind === 'desktop')
    expect(desktop?.connected).toBe(true)
    expect(await companion.revokeDevice(desktop!.id)).toBe(true)
    await wait(() => client.knownPeers()[0]?.error === 'revoked')
    expect(client.knownPeers()[0].online).toBe(false)
    expect(await companion.validateDeviceToken('0'.repeat(64))).toBe(false)
  }, 60_000)
})
