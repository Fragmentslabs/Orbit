import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { deriveOwner, safeSourceLink } from '@shared/fragment-provenance'

/** Provenance: a record outside the fragment folder, owner derived and never typed. */

const userData = path.join(os.tmpdir(), `orbit-provenance-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
}))

let store: typeof import('./fragment-store')
let provenance: typeof import('./fragment-provenance')

beforeAll(async () => {
  store = await import('./fragment-store')
  provenance = await import('./fragment-provenance')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('deriveOwner', () => {
  it('takes the owner from a github URL or shorthand', () => {
    expect(deriveOwner('https://github.com/fracta/app')).toBe('fracta')
    expect(deriveOwner('https://www.github.com/fracta/app/tree/main/x')).toBe('fracta')
    expect(deriveOwner('github:fracta/app')).toBe('fracta')
  })

  it('uses the host for other web URLs and nothing for the rest', () => {
    expect(deriveOwner('https://example.com/app.orbitfrag')).toBe('example.com')
    expect(deriveOwner(undefined)).toBeUndefined()
    expect(deriveOwner('/Users/me/app.orbitfrag')).toBeUndefined()
    expect(deriveOwner('javascript:alert(1)')).toBeUndefined()
  })

  it('only links web URLs', () => {
    expect(safeSourceLink('https://github.com/fracta/app')).toBe('https://github.com/fracta/app')
    expect(safeSourceLink('javascript:alert(1)')).toBeUndefined()
    expect(safeSourceLink('file:///etc/passwd')).toBeUndefined()
  })
})

describe('provenance record', () => {
  it('marks a created fragment as local, outside the fragment folder', async () => {
    const made = await store.createFragment({ name: 'Local one', html: '<p>hi</p>' })
    const found = await provenance.getProvenance(made.id, made.createdAt)
    expect(found.origin).toBe('local')
    const inside = await fsp.readdir(path.join(userData, 'orbit-data', 'fragments', made.id))
    expect(inside).not.toContain('provenance.json')
    const outside = await fsp.readdir(path.join(userData, 'orbit-data', 'fragment-provenance'))
    expect(outside).toContain(`${made.id}.json`)
  })

  it('reads a missing record as local and drops the record with the fragment', async () => {
    expect((await provenance.getProvenance('frag-old-aaaaaa', 5)).origin).toBe('local')
    const made = await store.createFragment({ name: 'To remove', html: '<p>x</p>' })
    await store.removeFragment(made.id)
    const outside = await fsp.readdir(path.join(userData, 'orbit-data', 'fragment-provenance'))
    expect(outside).not.toContain(`${made.id}.json`)
  })

  it('keeps a third-party fragment third party when edited, and derives the owner', async () => {
    const made = await store.createFragment({ name: 'Imported', html: '<p>x</p>' })
    await provenance.recordThirdPartyProvenance(made.id, {
      arrival: 'repository',
      sourceUrl: 'https://github.com/fracta/app',
      commit: 'a'.repeat(40),
    })
    await store.writeFragmentFile(made.id, 'index.html', '<p>changed</p>')
    const found = await provenance.getProvenance(made.id, made.createdAt)
    expect(found.origin).toBe('third_party')
    if (found.origin !== 'third_party') return
    expect(found.owner).toBe('fracta')
    expect(found.modifiedAt).toBeTypeOf('number')
    expect(found.commit).toBe('a'.repeat(40))
  })
})
