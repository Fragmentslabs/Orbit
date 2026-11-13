import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const userData = path.join(os.tmpdir(), `orbit-fragment-share-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
}))

let store: typeof import('../fragment-store')
let prov: typeof import('../fragment-provenance')
let share: typeof import('./fragment-share')

beforeAll(async () => {
  store = await import('../fragment-store')
  prov = await import('../fragment-provenance')
  share = await import('./fragment-share')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

async function exported() {
  const m = await store.createFragment({ name: 'Budget', html: '<h1>budget</h1>', requests: ['ai'] })
  await store.writeFragmentFile(m.id, 'app.js', 'console.log(1)')
  await store.setGrant(m.id, 'ai', true)
  await store.storeSet(m.id, 'secret', { token: 'sk-private' })
  const built = await share.buildFragmentArchive(m.id)
  return { m, built: built! }
}

describe('export', () => {
  it('carries code and requests, but no data, no grants and no provenance', async () => {
    const { built } = await exported()
    expect(built.suggestedName).toBe('budget.orbitfrag')
    const text = Buffer.from(built.bytes).toString('latin1')
    expect(text).not.toContain('sk-private')
    const preview = share.previewFragmentImport('x.orbitfrag', built.bytes)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.preview.files.map((f) => f.path)).toEqual(['app.js', 'index.html'])
    expect(preview.preview.requests).toEqual(['ai'])
  })

  it('returns null for an unknown fragment', async () => {
    expect(await share.buildFragmentArchive('frag-nope-000000')).toBeNull()
  })
})

describe('import', () => {
  it('writes nothing until confirmed, then grants nothing and records a third-party origin', async () => {
    const { built } = await exported()
    const before = (await store.listFragments()).length
    const preview = share.previewFragmentImport('/some/dir/../Budget.orbitfrag', built.bytes)
    if (!preview.ok) throw new Error('preview failed')
    expect(preview.preview.fileName).toBe('Budget.orbitfrag')
    expect((await store.listFragments()).length).toBe(before)

    const done = await share.confirmFragmentImport(preview.preview.token)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    const manifest = (await store.getFragment(done.fragmentId))!
    expect(manifest.grants).toEqual([])
    expect(manifest.requests).toEqual(['ai'])
    expect(manifest.pinned).toEqual({ sidebar: false, panel: false })
    expect(await store.storeKeys(done.fragmentId)).toEqual([])
    expect(await store.readFragmentFile(done.fragmentId, 'app.js')).toBe('console.log(1)')

    const provenance = await prov.getProvenance(done.fragmentId, manifest.createdAt)
    expect(provenance).toMatchObject({ origin: 'third_party', arrival: 'file', fileName: 'Budget.orbitfrag', fileHash: preview.preview.sha256 })
    expect(await prov.isFragmentUntrusted(done.fragmentId)).toBe(true)
  })

  it('spends the token: a second confirmation or a made-up token imports nothing', async () => {
    const { built } = await exported()
    const preview = share.previewFragmentImport('a.orbitfrag', built.bytes)
    if (!preview.ok) throw new Error('preview failed')
    expect((await share.confirmFragmentImport(preview.preview.token)).ok).toBe(true)
    expect(await share.confirmFragmentImport(preview.preview.token)).toEqual({ ok: false, code: 'expired' })
    expect(await share.confirmFragmentImport('nope')).toEqual({ ok: false, code: 'expired' })
    expect(await share.confirmFragmentImport(undefined)).toEqual({ ok: false, code: 'expired' })
  })

  it('a cancelled preview cannot be confirmed', async () => {
    const { built } = await exported()
    const preview = share.previewFragmentImport('a.orbitfrag', built.bytes)
    if (!preview.ok) throw new Error('preview failed')
    share.cancelFragmentImport(preview.preview.token)
    expect((await share.confirmFragmentImport(preview.preview.token)).ok).toBe(false)
  })

  it('refuses junk without creating anything', () => {
    expect(share.previewFragmentImport('x', 'not bytes')).toEqual({ ok: false, code: 'not_an_archive' })
    expect(share.previewFragmentImport('x', new Uint8Array([1, 2, 3]))).toEqual({ ok: false, code: 'not_an_archive' })
  })

  it('the author is a claim: recorded as such, and the owner stays empty for a file', async () => {
    const { packFragment } = await import('./package-codec')
    const bytes = packFragment({
      name: 'Claimed', kind: 'screen', icon: 'app-window', requests: [], author: 'github.com/fracta',
      files: [{ path: 'index.html', data: new TextEncoder().encode('<p>x</p>') }],
    })
    const preview = share.previewFragmentImport('claimed.orbitfrag', bytes)
    if (!preview.ok) throw new Error('preview failed')
    const done = await share.confirmFragmentImport(preview.preview.token)
    if (!done.ok) throw new Error('import failed')
    const provenance = await prov.getProvenance(done.fragmentId, 0)
    expect(provenance).toMatchObject({ origin: 'third_party', author: 'github.com/fracta' })
    expect((provenance as { owner?: string }).owner).toBeUndefined()
  })

  it('review lifts the untrusted mark and survives edits', async () => {
    const { built } = await exported()
    const preview = share.previewFragmentImport('r.orbitfrag', built.bytes)
    if (!preview.ok) throw new Error('preview failed')
    const done = await share.confirmFragmentImport(preview.preview.token)
    if (!done.ok) throw new Error('import failed')
    expect(await prov.markReviewed(done.fragmentId)).toBe(true)
    expect(await prov.isFragmentUntrusted(done.fragmentId)).toBe(false)
    await store.writeFragmentFile(done.fragmentId, 'app.js', 'edited')
    const after = await prov.getProvenance(done.fragmentId, 0)
    expect(after).toMatchObject({ origin: 'third_party', modifiedAt: expect.any(Number), reviewedAt: expect.any(Number) })
  })

  it('local fragments are never untrusted and cannot be "reviewed"', async () => {
    const m = await store.createFragment({ name: 'Mine', html: '<p/>' })
    expect(await prov.isFragmentUntrusted(m.id)).toBe(false)
    expect(await prov.markReviewed(m.id)).toBe(false)
  })
})

describe('safeFileName', () => {
  it('keeps only a bounded basename without control characters', () => {
    expect(share.safeFileName('/a/b/../c.orbitfrag')).toBe('c.orbitfrag')
    expect(share.safeFileName('C:\\x\\y.orbitfrag')).toBe('y.orbitfrag')
    expect(share.safeFileName('a\u0000b.orbitfrag')).toBe('ab.orbitfrag')
    expect(share.safeFileName('x'.repeat(500)).length).toBe(120)
    expect(share.safeFileName('')).toBe('fragment.orbitfrag')
  })
})
