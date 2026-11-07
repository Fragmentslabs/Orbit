import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** orbit.models: the page may list and pick the model of its own orbit.ai — only with the user's grant. */

const userData = path.join(os.tmpdir(), `orbit-models-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../providers', () => ({ resolveModel: async () => ({}) }))
vi.mock('../reasoning', () => ({ buildProviderOptions: async () => ({}) }))
vi.mock('../auth', () => ({ listCredentialProviders: async () => ['acme'] }))
vi.mock('../custom-providers', () => ({ listCustomProviders: async () => [] }))
vi.mock('../catalog', () => ({
  getMergedCatalog: async () => ({
    acme: {
      id: 'acme',
      name: 'Acme',
      models: {
        'acme-1': { id: 'acme-1', name: 'Acme One', reasoning: true, modalities: { input: ['text'], output: ['text'] } },
        'acme-img': { id: 'acme-img', name: 'Acme Image', reasoning: false, modalities: { input: ['text'], output: ['image'] } },
        'acme-old': { id: 'acme-old', name: 'Acme Old', reasoning: false, status: 'deprecated' },
      },
    },
    // Present in the catalog, but the person never connected it.
    other: { id: 'other', name: 'Other', models: { 'o-1': { id: 'o-1', name: 'O One', reasoning: false } } },
  }),
}))

let store: typeof import('./fragment-store')
let bridge: typeof import('./fragment-bridge')

beforeAll(async () => {
  store = await import('./fragment-store')
  bridge = await import('./fragment-bridge')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

async function fragmentWith(requests: ('ai' | 'models')[], grants: ('ai' | 'models')[]) {
  const made = await store.createFragment({ name: 'Picker', html: 'x', requests })
  for (const cap of grants) await store.setGrant(made.id, cap, true)
  return made.id
}
const call = (fragmentId: string, method: string, params?: unknown) => bridge.handleFragmentCall({ fragmentId, method, params })

describe('orbit.models in the broker', () => {
  it('refuses every call until the fragment asked AND the user allowed', async () => {
    const silent = await fragmentWith([], [])
    expect(await call(silent, 'models.list')).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
    const asked = await fragmentWith(['models'], [])
    expect(await call(asked, 'models.set', { providerId: 'acme', modelId: 'acme-1' })).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    })
    expect((await store.getFragment(asked))?.model).toBeUndefined()
  })

  it('lists only connected, current, text-producing models', async () => {
    const id = await fragmentWith(['models'], ['models'])
    const result = await call(id, 'models.list')
    expect(result).toEqual({
      ok: true,
      value: [{ providerId: 'acme', providerName: 'Acme', modelId: 'acme-1', name: 'Acme One', reasoning: true }],
    })
  })

  it('stores the pick on the manifest, refuses unknown ids, and null follows the chat again', async () => {
    const id = await fragmentWith(['ai', 'models'], ['ai', 'models'])
    expect(await call(id, 'models.get')).toEqual({ ok: true, value: null })

    expect(await call(id, 'models.set', { providerId: 'acme', modelId: 'acme-1' })).toEqual({ ok: true, value: null })
    expect(await call(id, 'models.get')).toEqual({ ok: true, value: { providerId: 'acme', modelId: 'acme-1' } })

    expect(await call(id, 'models.set', { providerId: 'other', modelId: 'o-1' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_params' },
    })
    expect((await store.getFragment(id))?.model).toEqual({ providerId: 'acme', modelId: 'acme-1' })

    expect(await call(id, 'models.set', { providerId: null })).toEqual({ ok: true, value: null })
    expect(await call(id, 'models.get')).toEqual({ ok: true, value: null })
  })

  it('setRequested leaves the other requests alone', async () => {
    const id = await fragmentWith(['ai'], [])
    expect((await store.setRequested(id, 'models', true))?.requests).toEqual(['ai', 'models'])
    expect((await store.setRequested(id, 'ai', false))?.requests).toEqual(['models'])
  })
})
