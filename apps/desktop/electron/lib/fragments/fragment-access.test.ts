import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeFragmentHost, sanitizeFragmentHosts, sanitizeFragmentMcp } from '@shared/fragments'
import type { FragmentManifest } from '@shared/fragments'
import { isBlockedAddress } from './fragment-address'
import { createBudget } from './fragment-budget'
import { readCapped, type Transport, type TransportRequest } from './fragment-http-transport'

/**
 * orbit.http and orbit.mcp: the host allowlist, the caps, every denial path and what the
 * broker checks before either of them runs.
 */

const userData = path.join(os.tmpdir(), `orbit-fragment-access-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))
vi.mock('../media', () => ({ injectArtifactChrome: (html: string) => html }))
vi.mock('../providers', () => ({ resolveModel: async () => ({}) }))
vi.mock('../reasoning', () => ({ buildProviderOptions: async () => ({}) }))

const mcp = vi.hoisted(() => ({
  servers: new Map<string, string[]>(),
  call: vi.fn(async (_server: string, _tool: string, _args: unknown, _ms: number): Promise<unknown> => ({ content: [{ type: 'text', text: 'hello' }] })),
}))
vi.mock('../mcp', () => ({
  listMcpServerToolNames: (server: string) => mcp.servers.get(server) ?? null,
  callMcpToolByName: mcp.call,
}))

let store: typeof import('./fragment-store')
let bridge: typeof import('./fragment-bridge')
let http: typeof import('./fragment-http')
let fragmentMcp: typeof import('./fragment-mcp')

beforeAll(async () => {
  store = await import('./fragment-store')
  bridge = await import('./fragment-bridge')
  http = await import('./fragment-http')
  fragmentMcp = await import('./fragment-mcp')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

function manifestWith(hosts: string[], id = `frag-test-${Math.random().toString(16).slice(2, 8)}`): FragmentManifest {
  return { id, hosts, mcp: [] } as unknown as FragmentManifest
}

function ok(status: number, text = '', headers: Record<string, string> = {}) {
  return { status, headers, body: Buffer.from(text), truncated: false }
}

describe('declarations', () => {
  it.each([
    ['api.example.com', 'api.example.com'],
    ['  API.Example.COM ', 'api.example.com'],
    ['https://api.example.com/v1/x?y=1', 'api.example.com'],
  ])('accepts %s', (raw, expected) => expect(normalizeFragmentHost(raw)).toBe(expected))

  it.each([
    'localhost', '127.0.0.1', '10.0.0.5', '[::1]', 'intranet', 'printer.local', 'db.internal', '*.example.com',
    'http://example.com', 'https://user:pw@example.com', 'https://example.com:8443', 'example.com/path', '', 42, null,
  ])('refuses %s', (raw) => expect(normalizeFragmentHost(raw)).toBeNull())

  it('dedupes hosts and caps the list', () => {
    expect(sanitizeFragmentHosts(['a.com', 'A.com', 'b.com', 'localhost'])).toEqual(['a.com', 'b.com'])
    const many = Array.from({ length: 30 }, (_, i) => `h${i}.example.com`)
    expect(sanitizeFragmentHosts(many)).toHaveLength(10)
  })

  it('merges MCP entries per server and drops malformed ones', () => {
    expect(
      sanitizeFragmentMcp([
        { server: 'github', tools: ['a'] },
        { server: 'github', tools: ['b', 'a'] },
        { server: 'empty', tools: [] },
        { server: '', tools: ['x'] },
        'nope',
        { server: 'bad', tools: 'x' },
      ]),
    ).toEqual([{ server: 'github', tools: ['a', 'b'] }])
  })
})

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip',
  ])('blocks %s', (address) => expect(isBlockedAddress(address)).toBe(true))

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('lets %s through', (address) =>
    expect(isBlockedAddress(address)).toBe(false),
  )
})

describe('readCapped', () => {
  it('returns everything under the cap', async () => {
    const out = await readCapped(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 10)
    expect(out.body.toString()).toBe('abcdef')
    expect(out.truncated).toBe(false)
  })
  it('cuts at the cap, flags it and stops reading', async () => {
    const stream = Readable.from([Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('ijkl')])
    const out = await readCapped(stream, 6)
    expect(out.body.toString()).toBe('abcdef')
    expect(out.truncated).toBe(true)
    expect(stream.destroyed).toBe(true)
  })
})

describe('budget', () => {
  it('limits calls per minute and at the same time, and frees a slot on release', () => {
    const b = createBudget({ label: 'x', perMinute: 3, concurrent: 2 })
    const first = b.take('f')
    const second = b.take('f')
    expect(b.take('f')).toEqual({ refused: 'at most 2 x calls at the same time' })
    ;(first as { release: () => void }).release()
    ;(second as { release: () => void }).release()
    expect('release' in b.take('f')).toBe(true) // third of three this minute
    expect(b.take('f')).toEqual({ refused: 'at most 3 x calls per minute' })
    expect('release' in b.take('other')).toBe(true) // per fragment
  })
})

describe('orbit.http', () => {
  const calls: TransportRequest[] = []
  let reply: (req: TransportRequest) => ReturnType<Transport>
  const transport: Transport = (req) => {
    calls.push(req)
    return reply(req)
  }
  const fetchAs = (m: FragmentManifest, params: Record<string, unknown>) => http.fragmentHttpFetch(m, params, transport)
  const code = (r: Awaited<ReturnType<typeof fetchAs>>) => (r.ok ? 'ok' : r.error.code)

  beforeEach(() => {
    calls.length = 0
    reply = async () => ok(200, '{"a":1}', { 'content-type': 'application/json' })
  })

  it('fetches an allowed host and returns status, headers and text', async () => {
    const r = await fetchAs(manifestWith(['api.example.com']), { url: 'https://api.example.com/v1?q=1' })
    expect(r).toMatchObject({ ok: true, value: { status: 200, ok: true, text: '{"a":1}', truncated: false } })
    expect(calls[0].url.toString()).toBe('https://api.example.com/v1?q=1')
  })

  it('never sends cookies or credentials and asks for an uncompressed body', async () => {
    await fetchAs(manifestWith(['api.example.com']), { url: 'https://api.example.com/', headers: { 'X-Thing': 'y' } })
    expect(Object.keys(calls[0].headers).sort()).toEqual(['accept-encoding', 'user-agent', 'x-thing'])
  })

  it.each(['cookie', 'Authorization', 'proxy-authorization', 'host', 'content-length', 'sec-fetch-mode', 'origin'])(
    'refuses the header %s',
    async (name) => {
      const r = await fetchAs(manifestWith(['api.example.com']), { url: 'https://api.example.com/', headers: { [name]: 'x' } })
      expect(code(r)).toBe('invalid_params')
      expect(calls).toHaveLength(0)
    },
  )

  it('refuses CR/LF in a header value', async () => {
    const r = await fetchAs(manifestWith(['api.example.com']), { url: 'https://api.example.com/', headers: { 'x-a': 'b\r\nc: d' } })
    expect(code(r)).toBe('invalid_params')
  })

  it.each([
    ['an undeclared host', 'https://evil.example.org/'],
    ['a sibling subdomain', 'https://other.example.com/'],
    ['a lookalike suffix', 'https://api.example.com.evil.org/'],
  ])('refuses %s', async (_label, url) => {
    expect(code(await fetchAs(manifestWith(['api.example.com']), { url }))).toBe('host_not_allowed')
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['plain http', 'http://api.example.com/'],
    ['another port', 'https://api.example.com:8443/'],
    ['credentials in the url', 'https://u:p@api.example.com/'],
    ['a file url', 'file:///etc/passwd'],
    ['garbage', 'not a url'],
    ['a non-string', 42],
  ])('refuses %s', async (_label, url) => {
    expect(code(await fetchAs(manifestWith(['api.example.com']), { url }))).toBe('invalid_params')
  })

  it('refuses everything when no host is declared', async () => {
    expect(code(await fetchAs(manifestWith([]), { url: 'https://api.example.com/' }))).toBe('host_not_allowed')
  })

  it('refuses unknown methods, a body on GET, a non-string body and an oversized body', async () => {
    const m = manifestWith(['api.example.com'])
    const url = 'https://api.example.com/'
    expect(code(await fetchAs(m, { url, method: 'TRACE' }))).toBe('invalid_params')
    expect(code(await fetchAs(m, { url, body: 'x' }))).toBe('invalid_params')
    expect(code(await fetchAs(m, { url, method: 'POST', body: { a: 1 } }))).toBe('invalid_params')
    expect(code(await fetchAs(m, { url, method: 'POST', body: 'x'.repeat(256 * 1024 + 1) }))).toBe('invalid_params')
    expect(code(await fetchAs(m, { url, method: 'post', body: '{}' }))).toBe('ok')
    expect(calls[0].method).toBe('POST')
  })

  it('passes the response cap and the time left to the transport and reports truncation', async () => {
    reply = async () => ({ ...ok(200, 'abc'), truncated: true })
    const r = await fetchAs(manifestWith(['api.example.com']), { url: 'https://api.example.com/' })
    expect(r).toMatchObject({ ok: true, value: { truncated: true } })
    expect(calls[0].maxBytes).toBe(2 * 1024 * 1024)
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(20_000)
  })

  it('follows a redirect inside the allowlist and re-checks the host on every hop', async () => {
    const m = manifestWith(['a.example.com', 'b.example.com'])
    reply = async (req) =>
      req.url.hostname === 'a.example.com' ? ok(302, '', { location: 'https://b.example.com/done' }) : ok(200, 'done')
    const r = await fetchAs(m, { url: 'https://a.example.com/' })
    expect(r).toMatchObject({ ok: true, value: { text: 'done', url: 'https://b.example.com/done' } })

    calls.length = 0
    reply = async () => ok(302, '', { location: 'https://evil.example.org/' })
    expect(code(await fetchAs(m, { url: 'https://a.example.com/' }))).toBe('host_not_allowed')
    reply = async () => ok(302, '', { location: 'http://b.example.com/' })
    expect(code(await fetchAs(m, { url: 'https://a.example.com/' }))).toBe('invalid_params')
  })

  it('turns a POST into a GET without a body on 303 and stops after too many redirects', async () => {
    const m = manifestWith(['a.example.com'])
    reply = async (req) => (req.method === 'POST' ? ok(303, '', { location: '/next' }) : ok(200, 'x'))
    await fetchAs(m, { url: 'https://a.example.com/', method: 'POST', body: '{}' })
    expect(calls[1]).toMatchObject({ method: 'GET', body: undefined })

    reply = async () => ok(302, '', { location: '/again' })
    const loop = await fetchAs(m, { url: 'https://a.example.com/' })
    expect(loop).toMatchObject({ ok: false, error: { code: 'http_failed', message: 'too many redirects' } })
  })

  it('surfaces a transport failure as http_failed', async () => {
    reply = async () => {
      throw new Error('host resolves to a private or local address')
    }
    const r = await fetchAs(manifestWith(['api.example.com']), { url: 'https://api.example.com/' })
    expect(r).toMatchObject({ ok: false, error: { code: 'http_failed', message: 'host resolves to a private or local address' } })
  })

  it('rate limits a runaway page per fragment', async () => {
    const m = manifestWith(['api.example.com'])
    const results = []
    for (let i = 0; i < 31; i++) results.push(await fetchAs(m, { url: 'https://api.example.com/' }))
    expect(results.slice(0, 30).every((r) => r.ok)).toBe(true)
    expect(code(results[30])).toBe('rate_limited')
    expect(code(await fetchAs(manifestWith(['api.example.com']), { url: 'https://api.example.com/' }))).toBe('ok')
  })
})

describe('orbit.mcp', () => {
  const manifest = { id: 'frag-mcp-aaaaaa', hosts: [], mcp: [{ server: 'github', tools: ['search', 'get'] }] } as unknown as FragmentManifest

  beforeEach(() => {
    mcp.servers.clear()
    mcp.servers.set('github', ['search', 'get', 'delete_repo'])
    mcp.call.mockClear()
    mcp.call.mockImplementation(async () => ({ content: [{ type: 'text', text: 'hello' }] }))
  })

  it('calls a declared tool and returns its text', async () => {
    const r = await fragmentMcp.fragmentMcpCall(manifest, { server: 'github', tool: 'search', args: { q: 'x' } })
    expect(r).toEqual({ ok: true, value: { text: 'hello', truncated: false } })
    expect(mcp.call).toHaveBeenCalledWith('github', 'search', { q: 'x' }, 60_000)
  })

  it('refuses a tool or server it did not declare, even when the server has the tool', async () => {
    expect(await fragmentMcp.fragmentMcpCall(manifest, { server: 'github', tool: 'delete_repo' })).toMatchObject({
      ok: false,
      error: { code: 'tool_not_allowed' },
    })
    expect(await fragmentMcp.fragmentMcpCall(manifest, { server: 'slack', tool: 'search' })).toMatchObject({
      ok: false,
      error: { code: 'tool_not_allowed' },
    })
    expect(mcp.call).not.toHaveBeenCalled()
  })

  it('says so when the server is not connected', async () => {
    mcp.servers.clear()
    expect(await fragmentMcp.fragmentMcpCall(manifest, { server: 'github', tool: 'search' })).toMatchObject({
      ok: false,
      error: { code: 'mcp_unavailable' },
    })
  })

  it.each([
    [{ server: 'github' }],
    [{ tool: 'search' }],
    [{ server: 1, tool: 2 }],
    [{ server: 'github', tool: 'search', args: [1] }],
    [{ server: 'github', tool: 'search', args: 'x' }],
    [{ server: 'github', tool: 'search', args: { big: 'x'.repeat(70 * 1024) } }],
  ])('validates params %j', async (params) => {
    expect(await fragmentMcp.fragmentMcpCall(manifest, params)).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
  })

  it('surfaces a tool error with its text, and a thrown failure', async () => {
    mcp.call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'rate limit' }] })
    expect(await fragmentMcp.fragmentMcpCall(manifest, { server: 'github', tool: 'get' })).toEqual({
      ok: false,
      error: { code: 'mcp_tool_error', message: 'rate limit' },
    })
    mcp.call.mockRejectedValueOnce(new Error('boom'))
    expect(await fragmentMcp.fragmentMcpCall(manifest, { server: 'github', tool: 'get' })).toEqual({
      ok: false,
      error: { code: 'mcp_failed', message: 'boom' },
    })
  })

  it('bounds the result', async () => {
    mcp.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'y'.repeat(90_000) }] })
    const r = await fragmentMcp.fragmentMcpCall(manifest, { server: 'github', tool: 'get' })
    expect(r.ok && (r.value as { text: string; truncated: boolean }).text.length).toBe(60_000)
    expect(r.ok && (r.value as { truncated: boolean }).truncated).toBe(true)
  })

  it('lists declared pairs with their live availability', () => {
    mcp.servers.set('github', ['search'])
    expect(fragmentMcp.fragmentMcpList(manifest)).toEqual({
      ok: true,
      value: [{ server: 'github', connected: true, tools: [{ name: 'search', available: true }, { name: 'get', available: false }] }],
    })
  })
})

describe('the broker', () => {
  async function fragment(requests: ('http' | 'mcp')[], grants: ('http' | 'mcp')[]) {
    const created = await store.createFragment({ name: 'access', html: 'x', requests })
    await store.setFragmentHosts(created.id, ['api.example.com'])
    await store.setFragmentMcp(created.id, [{ server: 'github', tools: ['search'] }])
    for (const g of grants) await store.setGrant(created.id, g, true)
    return created.id
  }
  const call = (fragmentId: string, method: unknown, params?: unknown) => bridge.handleFragmentCall({ fragmentId, method: method as string, params })

  it('denies http and mcp when not requested, and when requested but not allowed', async () => {
    const none = await fragment([], [])
    expect(await call(none, 'http.fetch', { url: 'https://api.example.com/' })).toMatchObject({ error: { code: 'permission_denied', message: expect.stringContaining('did not declare') } })
    expect(await call(none, 'mcp.call', { server: 'github', tool: 'search' })).toMatchObject({ error: { code: 'permission_denied' } })
    const asked = await fragment(['http', 'mcp'], [])
    expect(await call(asked, 'http.fetch', { url: 'https://api.example.com/' })).toMatchObject({ error: { code: 'permission_denied', message: expect.stringContaining('not allowed') } })
    expect(await call(asked, 'mcp.list')).toMatchObject({ error: { code: 'permission_denied' } })
  })

  it('reaches the handlers once allowed (and the handlers keep refusing what is not declared)', async () => {
    const id = await fragment(['http', 'mcp'], ['http', 'mcp'])
    expect(await call(id, 'http.fetch', { url: 'https://other.example.org/' })).toMatchObject({ error: { code: 'host_not_allowed' } })
    mcp.servers.set('github', ['search'])
    expect(await call(id, 'mcp.call', { server: 'github', tool: 'search' })).toMatchObject({ ok: true })
    expect(await call(id, 'mcp.call', { server: 'github', tool: 'other' })).toMatchObject({ error: { code: 'tool_not_allowed' } })
  })

  it.each(['', 'http.fetchh', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 42, null, undefined, { a: 1 }])(
    'rejects the method %j',
    async (method) => {
      const id = await fragment(['http'], ['http'])
      expect(await call(id, method)).toMatchObject({ ok: false, error: { code: 'unknown_method' } })
    },
  )

  it('treats non-object params as empty instead of crashing', async () => {
    const id = await fragment(['http'], ['http'])
    for (const params of [null, 'str', 5, [1, 2]]) {
      expect(await call(id, 'http.fetch', params)).toMatchObject({ ok: false, error: { code: 'invalid_params' } })
    }
  })

  it('answers not_found for a fragment that is gone or an id that is not one', async () => {
    expect(await call('frag-nope-000000', 'mcp.list')).toMatchObject({ error: { code: 'not_found' } })
    expect(await call('../etc', 'mcp.list')).toMatchObject({ error: { code: 'not_found' } })
  })

  it('withdraws the grant when the declaration widens, keeps it when it narrows', async () => {
    const id = await fragment(['http', 'mcp'], ['http', 'mcp'])
    let m = await store.setFragmentHosts(id, ['api.example.com', 'more.example.com'])
    expect(m?.grants).toEqual(['mcp'])
    await store.setGrant(id, 'http', true)
    m = await store.setFragmentHosts(id, ['api.example.com'])
    expect(m?.grants).toContain('http')
    m = await store.setFragmentMcp(id, [{ server: 'github', tools: ['search', 'get'] }])
    expect(m?.grants).not.toContain('mcp')
  })

  it('an agent cannot grant: declaring never adds to grants', async () => {
    const id = await fragment([], [])
    const m = await store.setFragmentHosts(id, ['x.example.com'])
    expect(m?.grants).toEqual([])
    expect(await store.setGrant(id, 'http', true)).toMatchObject({ grants: [] }) // not requested → no grant
  })
})
