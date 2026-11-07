import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Fragments: the files the scheme may serve, the grants only the user can give, the
 * broker's refusals and what the scheme puts around the page.
 */

const userData = path.join(os.tmpdir(), `orbit-fragments-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

// The scheme handler imports media.ts for the shared theme tokens; the tokens are not
// what is under test here.
vi.mock('../media', () => ({
  injectArtifactChrome: (html: string) => html + '<!--chrome-->',
}))

// The model call itself: what is under test is what the bridge hands to it.
const ai = vi.hoisted(() => ({ generateText: vi.fn(async (_args: unknown) => ({ text: 'ok' })) }))
vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), generateText: ai.generateText }))
vi.mock('../providers', () => ({ resolveModel: async () => ({ id: 'model' }) }))
vi.mock('../reasoning', () => ({
  buildProviderOptions: async (input: { providerId: string; options: { reasoning?: { variantId?: string } } }) => ({
    [input.providerId]: { effort: input.options.reasoning?.variantId ?? 'default' },
  }),
}))

let store: typeof import('./fragment-store')
let bridge: typeof import('./fragment-bridge')
let scheme: typeof import('./fragment-protocol')
let sdk: typeof import('./fragment-sdk')

beforeAll(async () => {
  store = await import('./fragment-store')
  bridge = await import('./fragment-bridge')
  scheme = await import('./fragment-protocol')
  sdk = await import('./fragment-sdk')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('fragment-store', () => {
  it('creates a fragment with a URL-safe id and index.html', async () => {
    const m = await store.createFragment({ name: 'Controle de Gastos', html: '<h1>oi</h1>' })
    expect(m.id).toMatch(/^frag-controle-de-gastos-[0-9a-f]{6}$/)
    expect(store.isFragmentId(m.id)).toBe(true)
    expect(await store.readFragmentFile(m.id, 'index.html')).toBe('<h1>oi</h1>')
    expect(m.grants).toEqual([])
  })

  it('bumps the revision on every write and emits an update', async () => {
    const m = await store.createFragment({ name: 'rev', html: '<p>1</p>' })
    const seen: number[] = []
    store.fragmentEvents.on('updated', (e: { fragmentId: string; revision: number }) => {
      if (e.fragmentId === m.id) seen.push(e.revision)
    })
    const next = await store.writeFragmentFile(m.id, 'style.css', 'body{}')
    expect(next.revision).toBe(m.revision + 1)
    expect(seen).toContain(next.revision)
  })

  it.each(['../secret.html', 'a/../../b.html', '.hidden.html', 'dir//x.html', 'run.exe', 'noext'])(
    'refuses the path %s',
    async (bad) => {
      const m = await store.createFragment({ name: 'paths', html: 'x' })
      await expect(store.writeFragmentFile(m.id, bad, 'x')).rejects.toThrow()
      expect(await store.readFragmentAsset(m.id, bad)).toBeNull()
    },
  )

  it('treats a leading slash as relative: an "absolute" path stays inside src/', async () => {
    const m = await store.createFragment({ name: 'abs', html: 'x' })
    await store.writeFragmentFile(m.id, '/etc/passwd.html', 'inside')
    expect(await store.listFragmentFiles(m.id)).toContain('etc/passwd.html')
    expect(await store.readFragmentFile(m.id, 'etc/passwd.html')).toBe('inside')
  })

  it('never serves the manifest or the data file', async () => {
    const m = await store.createFragment({ name: 'private', html: 'x' })
    await store.storeSet(m.id, 'k', 'v')
    expect(await store.readFragmentAsset(m.id, '../manifest.json')).toBeNull()
    expect(await store.readFragmentAsset(m.id, '../data.json')).toBeNull()
    expect(await store.readFragmentAsset(m.id, 'manifest.json')).toBeNull()
  })

  it('keeps index.html', async () => {
    const m = await store.createFragment({ name: 'entry', html: 'x' })
    await expect(store.deleteFragmentFile(m.id, 'index.html')).rejects.toThrow()
  })

  it('serializes concurrent edits of the same file so neither is lost', async () => {
    const m = await store.createFragment({ name: 'race', html: 'a|b' })
    await Promise.all([
      store.editFragmentFile(m.id, 'index.html', (cur) => (cur ?? '').replace('a', 'A')),
      store.editFragmentFile(m.id, 'index.html', (cur) => (cur ?? '').replace('b', 'B')),
    ])
    expect(await store.readFragmentFile(m.id, 'index.html')).toBe('A|B')
  })

  it('rejects an edit whose transform throws and leaves the file alone', async () => {
    const m = await store.createFragment({ name: 'reject', html: 'keep' })
    await expect(
      store.editFragmentFile(m.id, 'index.html', () => {
        throw new Error('no match')
      }),
    ).rejects.toThrow('no match')
    expect(await store.readFragmentFile(m.id, 'index.html')).toBe('keep')
    expect((await store.getFragment(m.id))?.revision).toBe(m.revision)
  })

  it('keeps data across code rewrites', async () => {
    const m = await store.createFragment({ name: 'data', html: 'x' })
    await store.storeSet(m.id, 'todos', [{ a: 1 }])
    await store.writeFragmentFile(m.id, 'index.html', 'new')
    expect(await store.storeGet(m.id, 'todos')).toEqual([{ a: 1 }])
    expect(await store.storeKeys(m.id)).toEqual(['todos'])
    await store.storeDelete(m.id, 'todos')
    expect(await store.storeGet(m.id, 'todos')).toBeNull()
  })

  it('serializes concurrent store writes without losing keys', async () => {
    const m = await store.createFragment({ name: 'race', html: 'x' })
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.storeSet(m.id, `k${i}`, i)))
    expect((await store.storeKeys(m.id)).length).toBe(20)
  })

  it('only grants what the fragment asked for, and a dropped request drops its grant', async () => {
    const none = await store.createFragment({ name: 'noai', html: 'x' })
    expect((await store.setGrant(none.id, 'ai', true))?.grants).toEqual([])

    const m = await store.createFragment({ name: 'ai', html: 'x', requests: ['ai'] })
    expect((await store.setGrant(m.id, 'ai', true))?.grants).toEqual(['ai'])
    expect((await store.requestCapabilities(m.id, []))?.grants).toEqual([])
  })

  it('removes the fragment and its data', async () => {
    const m = await store.createFragment({ name: 'gone', html: 'x' })
    expect(await store.removeFragment(m.id)).toBe(true)
    expect(await store.getFragment(m.id)).toBeNull()
    expect(await store.removeFragment(m.id)).toBe(false)
  })

  it('refuses an id that is not a fragment id', async () => {
    expect(store.isFragmentId('../x')).toBe(false)
    expect(await store.getFragment('../x')).toBeNull()
    expect(await store.removeFragment('../../etc')).toBe(false)
  })
})

describe('fragment kind, pins and model', () => {
  it('pins a new fragment where its kind lives', async () => {
    const screen = await store.createFragment({ name: 's', html: 'x', kind: 'screen' })
    const panel = await store.createFragment({ name: 'p', html: 'x', kind: 'panel' })
    const widget = await store.createFragment({ name: 'w', html: 'x', kind: 'widget' })
    expect(screen.pinned).toEqual({ sidebar: true, panel: false })
    expect(panel.pinned).toEqual({ sidebar: false, panel: true })
    expect(widget.pinned).toEqual({ sidebar: false, panel: false })
    expect((await store.createFragment({ name: 'd', html: 'x' })).kind).toBe('screen')
    // an unknown kind from a model falls back instead of poisoning the manifest
    expect((await store.createFragment({ name: 'bad', html: 'x', kind: 'nope' as never })).kind).toBe('screen')
  })

  it('updates meta without bumping the revision (the page must not reload)', async () => {
    const m = await store.createFragment({ name: 'meta', html: 'x', kind: 'widget' })
    const seen: number[] = []
    store.fragmentEvents.on('updated', (e: { fragmentId: string; revision: number }) => {
      if (e.fragmentId === m.id) seen.push(e.revision)
    })
    const next = await store.updateFragmentMeta(m.id, { name: '  Renamed  ', pinned: { sidebar: true } })
    expect(next?.name).toBe('Renamed')
    expect(next?.pinned).toEqual({ sidebar: true, panel: false })
    expect(next?.revision).toBe(m.revision)
    expect(seen).toEqual([m.revision]) // announced, so open views re-read the manifest
    expect((await store.getFragment(m.id))?.pinned.sidebar).toBe(true)
  })

  it('stores and clears the model, and ignores a malformed one', async () => {
    const m = await store.createFragment({ name: 'model', html: 'x', requests: ['ai'] })
    const set = await store.updateFragmentMeta(m.id, { model: { providerId: 'anthropic', modelId: 'claude-x' } })
    expect(set?.model).toEqual({ providerId: 'anthropic', modelId: 'claude-x' })
    const bad = await store.updateFragmentMeta(m.id, { model: { providerId: '', modelId: 'x' } })
    expect(bad?.model).toEqual({ providerId: 'anthropic', modelId: 'claude-x' })
    const cleared = await store.updateFragmentMeta(m.id, { model: null })
    expect(cleared?.model).toBeUndefined()
  })

  it('stores the thinking level of the fragment\'s model, turns it off, and refuses anything malformed', async () => {
    const m = await store.createFragment({ name: 'think', html: 'x', requests: ['ai'] })
    expect(m.reasoning).toBeUndefined()
    const on = await store.updateFragmentMeta(m.id, { reasoning: { enabled: true, variantId: 'high' } })
    expect(on?.reasoning).toEqual({ enabled: true, variantId: 'high' })
    expect((await store.getFragment(m.id))?.reasoning).toEqual({ enabled: true, variantId: 'high' })
    // a level with characters that do not belong to a variant id is dropped, the switch stays on
    const odd = await store.updateFragmentMeta(m.id, { reasoning: { enabled: true, variantId: '../x' } })
    expect(odd?.reasoning).toEqual({ enabled: true })
    // "disabled" is the same as none
    const disabled = await store.updateFragmentMeta(m.id, { reasoning: { enabled: false, variantId: 'low' } })
    expect(disabled?.reasoning).toBeUndefined()
    await store.updateFragmentMeta(m.id, { reasoning: { enabled: true } })
    const off = await store.updateFragmentMeta(m.id, { reasoning: null })
    expect(off?.reasoning).toBeUndefined()
  })

  it('keeps the icon the agent picked, and falls back for anything that is not a lucide-style name', async () => {
    expect((await store.createFragment({ name: 'i1', html: 'x', icon: 'chart-bar' })).icon).toBe('chart-bar')
    expect((await store.createFragment({ name: 'i2', html: 'x' })).icon).toBe('app-window')
    for (const bad of ['Chart Bar', '../x', '<img>', '', 'a'.repeat(60), 42 as never]) {
      expect((await store.createFragment({ name: 'i3', html: 'x', icon: bad })).icon).toBe('app-window')
    }
    const m = await store.createFragment({ name: 'i4', html: 'x' })
    expect((await store.updateFragmentMeta(m.id, { icon: 'wallet' }))?.icon).toBe('wallet')
    expect((await store.updateFragmentMeta(m.id, { icon: 'NOT OK' }))?.icon).toBe('app-window')
  })

  it('reads a manifest written before kind/pins existed', async () => {
    const m = await store.createFragment({ name: 'legacy', html: 'x' })
    const file = path.join(userData, 'orbit-data', 'fragments', m.id, 'manifest.json')
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
    delete raw.kind
    delete raw.pinned
    await fsp.writeFile(file, JSON.stringify(raw), 'utf8')
    const read = await store.getFragment(m.id)
    expect(read?.kind).toBe('screen')
    expect(read?.pinned).toEqual({ sidebar: true, panel: false })
  })
})

describe('fragment bridge', () => {
  it('serves the store without any grant', async () => {
    const m = await store.createFragment({ name: 'bridge-store', html: 'x' })
    const set = await bridge.handleFragmentCall({ fragmentId: m.id, method: 'store.set', params: { key: 'a', value: 1 } })
    expect(set.ok).toBe(true)
    const get = await bridge.handleFragmentCall({ fragmentId: m.id, method: 'store.get', params: { key: 'a' } })
    expect(get).toEqual({ ok: true, value: 1 })
  })

  it('refuses unknown methods, including inherited object keys', async () => {
    const m = await store.createFragment({ name: 'bridge-unknown', html: 'x' })
    for (const method of ['fs.read', 'constructor', 'toString', '__proto__']) {
      const res = await bridge.handleFragmentCall({ fragmentId: m.id, method })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.code).toBe('unknown_method')
    }
  })

  it('gives orbit.ai the thinking level the person chose for the fragment\'s model', async () => {
    const m = await store.createFragment({ name: 'thinking-call', html: 'x', requests: ['ai'] })
    await store.setGrant(m.id, 'ai', true)
    await store.updateFragmentMeta(m.id, { model: { providerId: 'anthropic', modelId: 'claude-x' } })
    const call = () => bridge.handleFragmentCall({ fragmentId: m.id, method: 'ai.generate', params: { prompt: 'hi' } })

    ai.generateText.mockClear()
    expect((await call()).ok).toBe(true)
    expect((ai.generateText.mock.calls[0][0] as { providerOptions?: unknown }).providerOptions).toBeUndefined()

    await store.updateFragmentMeta(m.id, { reasoning: { enabled: true, variantId: 'high' } })
    ai.generateText.mockClear()
    expect((await call()).ok).toBe(true)
    expect((ai.generateText.mock.calls[0][0] as { providerOptions?: unknown }).providerOptions).toEqual({ anthropic: { effort: 'high' } })
  })

  it('refuses orbit.ai when not declared, and when declared but not allowed by the user', async () => {
    const plain = await store.createFragment({ name: 'plain', html: 'x' })
    const a = await bridge.handleFragmentCall({ fragmentId: plain.id, method: 'ai.generate', params: { prompt: 'hi' } })
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error.code).toBe('permission_denied')

    const asks = await store.createFragment({ name: 'asks', html: 'x', requests: ['ai'] })
    const b = await bridge.handleFragmentCall({ fragmentId: asks.id, method: 'ai.generate', params: { prompt: 'hi' } })
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error.message).toMatch(/not allowed/)
  })

  it('answers not_found for a fragment that does not exist', async () => {
    const res = await bridge.handleFragmentCall({ fragmentId: 'frag-nope-000000', method: 'store.keys' })
    expect(res.ok).toBe(false)
  })
})

describe('fragment scheme', () => {
  it('serves index.html with the SDK first, the closed CSP and no cache', async () => {
    const m = await store.createFragment({
      name: 'scheme',
      html: '<!doctype html><html><head><title>t</title></head><body>hi</body></html>',
    })
    const res = await scheme.handleFragmentRequest(new Request(`orbit-fragment://${m.id}/`))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body.indexOf('window.orbit')).toBeGreaterThan(0)
    expect(body.indexOf(sdk.FRAGMENT_SDK_MARK)).toBeLessThan(body.indexOf('<title>'))
    expect(body).toContain('<!--chrome-->')
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toMatch(/https?:/)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('serves other files with their type and without the SDK', async () => {
    const m = await store.createFragment({ name: 'assets', html: 'x' })
    await store.writeFragmentFile(m.id, 'app.js', 'console.log(1)')
    const res = await scheme.handleFragmentRequest(new Request(`orbit-fragment://${m.id}/app.js`))
    expect(res.headers.get('Content-Type')).toContain('text/javascript')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('404s for unknown fragments, forbidden paths and bad methods', async () => {
    const m = await store.createFragment({ name: 'nf', html: 'x' })
    expect((await scheme.handleFragmentRequest(new Request(`orbit-fragment://frag-nope-000000/`))).status).toBe(404)
    expect((await scheme.handleFragmentRequest(new Request(`orbit-fragment://${m.id}/..%2Fmanifest.json`))).status).toBe(404)
    expect((await scheme.handleFragmentRequest(new Request(`orbit-fragment://${m.id}/`, { method: 'POST' }))).status).toBe(405)
  })

  it('injects the SDK only once, and also into a document without <head>', () => {
    const once = sdk.injectFragmentSdk(sdk.injectFragmentSdk('<head></head>'))
    expect(once.split(sdk.FRAGMENT_SDK_MARK).length - 1).toBe(1)
    expect(sdk.injectFragmentSdk('<p>x</p>').startsWith(sdk.FRAGMENT_SDK_MARK)).toBe(true)
  })
})
