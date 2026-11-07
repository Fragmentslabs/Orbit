import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Per-turn history: each agent write is a revision, and a revert puts the files back exactly. */

const userData = path.join(os.tmpdir(), `orbit-history-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
}))

let store: typeof import('./fragment-store')
let history: typeof import('./fragment-history')

beforeAll(async () => {
  store = await import('./fragment-store')
  history = await import('./fragment-history')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

const write = (id: string, turn: string, file: string, content: string) =>
  history.withRevision(id, { turn }, { path: file }, () => store.writeFragmentFile(id, file, content))

describe('fragment history', () => {
  it('records each write with its turn and never exposes the stored content', async () => {
    const made = await store.createFragment({ name: 'Hist', html: 'v1' })
    await write(made.id, 't1', 'index.html', 'v2')
    await write(made.id, 't1', 'style.css', 'body{}')
    const list = await history.listRevisions(made.id)
    expect(list.map((r) => [r.turn, r.path, r.kind])).toEqual([
      ['t1', 'style.css', 'create'],
      ['t1', 'index.html', 'edit'],
    ])
    expect(JSON.stringify(list)).not.toContain('v1')
    expect(list[0].revision).toBeGreaterThan(list[1].revision)
  })

  it('reverts a turn exactly: edits restored, created files removed, deleted files back', async () => {
    const made = await store.createFragment({ name: 'Revert', html: 'v1' })
    await write(made.id, 'a', 'index.html', 'v2')
    await write(made.id, 'a', 'extra.css', 'x')
    await history.withRevision(made.id, { turn: 'b' }, { path: 'extra.css', deleting: true }, () =>
      store.deleteFragmentFile(made.id, 'extra.css'),
    )
    await write(made.id, 'b', 'index.html', 'v3')

    const turnB = (await history.listRevisions(made.id)).filter((r) => r.turn === 'b')
    const firstOfB = Math.min(...turnB.map((r) => r.revision))
    const reverted = await history.revertToBefore(made.id, firstOfB)
    expect(await store.readFragmentFile(made.id, 'index.html')).toBe('v2')
    expect(await store.readFragmentFile(made.id, 'extra.css')).toBe('x')
    // The page reloads: the revision moved forward, and turn b is gone from the history.
    expect(reverted?.revision).toBeGreaterThan(firstOfB)
    expect((await history.listRevisions(made.id)).map((r) => r.turn)).toEqual(['a', 'a'])

    const firstOfA = Math.min(...(await history.listRevisions(made.id)).map((r) => r.revision))
    await history.revertToBefore(made.id, firstOfA)
    expect(await store.readFragmentFile(made.id, 'index.html')).toBe('v1')
    expect(await store.readFragmentFile(made.id, 'extra.css')).toBeNull()
    expect(await history.listRevisions(made.id)).toEqual([])
  })

  it('refuses a revision that is not in the history', async () => {
    const made = await store.createFragment({ name: 'None', html: 'v1' })
    expect(await history.revertToBefore(made.id, 999)).toBeNull()
  })

  it('keeps only the most recent revisions', async () => {
    const made = await store.createFragment({ name: 'Many', html: 'v0' })
    for (let i = 1; i <= 85; i++) await write(made.id, `t${i}`, 'index.html', `v${i}`)
    const list = await history.listRevisions(made.id)
    expect(list).toHaveLength(80)
    expect(list[0].turn).toBe('t85')
  })

  it('does not stop a write when the history cannot be kept', async () => {
    const made = await store.createFragment({ name: 'Safe', html: 'v1' })
    await fsp.writeFile(path.join(userData, 'orbit-data', 'fragments', made.id, '.history'), 'not a folder')
    const next = await write(made.id, 't', 'index.html', 'v2')
    expect(next.revision).toBeGreaterThan(made.revision)
    expect(await store.readFragmentFile(made.id, 'index.html')).toBe('v2')
  })
})
