import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** The agent's side of orbit.http / orbit.mcp / fragment data: it declares and reads, never grants. */

const userData = path.join(os.tmpdir(), `orbit-fragment-access-tools-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
}))
const opened = vi.hoisted(() => vi.fn())
vi.mock('../panel-browser', () => ({ panelFragmentOpen: opened }))
vi.mock('../mcp', () => ({
  listMcpServerNames: () => ['github'],
  listMcpServerToolNames: (s: string) => (s === 'github' ? ['search'] : null),
}))

let store: typeof import('../fragments/fragment-store')
let tools: ReturnType<typeof import('./fragment').createFragmentTools>

type Run = (input: unknown) => Promise<unknown>
const run = (name: keyof typeof tools, input: unknown) => (tools[name] as unknown as { execute: Run }).execute(input)

beforeAll(async () => {
  store = await import('../fragments/fragment-store')
  tools = (await import('./fragment')).createFragmentTools('session-1')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('fragment access tools', () => {
  it('declares hosts, requests http and never allows it', async () => {
    const { id } = await store.createFragment({ name: 'weather', html: 'x' })
    const msg = await run('fragment_set_http', { fragmentId: id, hosts: ['https://api.open-meteo.com/v1', 'localhost', '10.0.0.1'] })
    expect(msg).toContain('api.open-meteo.com')
    expect(msg).toContain('2 entries were refused')
    const m = await store.getFragment(id)
    expect(m).toMatchObject({ hosts: ['api.open-meteo.com'], requests: ['http'], grants: [] })
    expect(await run('fragment_set_http', { fragmentId: id, hosts: [] })).toContain('no longer requested')
    expect((await store.getFragment(id))?.requests).toEqual([])
  })

  it('declares MCP access and warns about servers or tools that are not available', async () => {
    const { id } = await store.createFragment({ name: 'issues', html: 'x' })
    const msg = (await run('fragment_set_mcp', {
      fragmentId: id,
      access: [{ server: 'github', tools: ['search', 'nope'] }, { server: 'slack', tools: ['post'] }],
    })) as string
    expect(msg).toContain('github/nope (no such tool)')
    expect(msg).toContain('slack (not connected)')
    expect(await store.getFragment(id)).toMatchObject({ requests: ['mcp'], grants: [] })
  })

  it('reports an unknown fragment instead of throwing', async () => {
    for (const name of ['fragment_set_http', 'fragment_set_mcp', 'fragment_open', 'fragment_read_data'] as const) {
      expect(await run(name, { fragmentId: 'frag-gone-000000', hosts: [], access: [] })).toContain('Fragment not found')
    }
  })

  it('opens a fragment in the panel', async () => {
    const { id } = await store.createFragment({ name: 'open me', html: 'x' })
    opened.mockClear()
    expect(await run('fragment_open', { fragmentId: id })).toContain('Opened')
    expect(opened).toHaveBeenCalledWith({ id, title: 'open me', sessionId: 'session-1' })
  })

  it('reads saved data: keys with size, one value, a missing key, and cuts long values', async () => {
    const { id } = await store.createFragment({ name: 'data', html: 'x' })
    expect(await run('fragment_read_data', { fragmentId: id })).toBe('Nothing saved yet.')
    await store.storeSet(id, 'todos', [{ t: 'a' }])
    await store.storeSet(id, 'big', 'z'.repeat(100_000))
    const keys = (await run('fragment_read_data', { fragmentId: id })) as { key: string }[]
    expect(keys.map((k) => k.key).sort()).toEqual(['big', 'todos'])
    expect(await run('fragment_read_data', { fragmentId: id, key: 'todos' })).toContain('"t": "a"')
    expect(await run('fragment_read_data', { fragmentId: id, key: 'nope' })).toBe('No such key: nope')
    expect(await run('fragment_read_data', { fragmentId: id, key: '__proto__' })).toBe('No such key: __proto__')
    expect(((await run('fragment_read_data', { fragmentId: id, key: 'big' })) as string).length).toBeLessThan(31_000)
  })

  it('lists what each fragment asked for and what was allowed', async () => {
    const { id } = await store.createFragment({ name: 'listed', html: 'x', requests: ['ai'] })
    const list = (await run('fragment_list', {})) as { fragmentId: string; asked: string[]; allowedByUser: string[] }[]
    expect(list.find((f) => f.fragmentId === id)).toMatchObject({ asked: ['ai'], allowedByUser: [] })
  })
})
