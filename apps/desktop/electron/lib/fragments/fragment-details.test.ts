import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/chat'

const userData = path.join(os.tmpdir(), `orbit-details-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
}))

const chats = vi.hoisted(() => ({ ids: [] as string[] }))
vi.mock('../artifacts/chat-registry', () => ({
  listArtifactChats: async () => ({ sessionIds: chats.ids }),
}))
const saved = vi.hoisted(() => ({ messages: {} as Record<string, unknown> }))
vi.mock('../storage', () => ({
  readJson: async (key: string) => saved.messages[key] ?? null,
}))

let store: typeof import('./fragment-store')
let details: typeof import('./fragment-details')

beforeAll(async () => {
  store = await import('./fragment-store')
  details = await import('./fragment-details')
})
afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

const assistant = (input: number, output: number, cost?: number): ChatMessage =>
  ({ role: 'assistant', parts: [], createdAt: 1, tokens: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost } }) as unknown as ChatMessage

describe('sumSpend', () => {
  it('adds only the assistant messages of every chat', () => {
    const user = { role: 'user', parts: [], createdAt: 1 } as unknown as ChatMessage
    const spend = details.sumSpend([[user, assistant(100, 20, 0.5)], [assistant(10, 5)]])
    expect(spend).toEqual({ chats: 2, input: 110, output: 25, cost: 0.5 })
  })
})

describe('getFragmentDetails', () => {
  it('measures files and data keys and sums the chats that worked on it', async () => {
    chats.ids = ['chat-a']
    saved.messages['messages/chat-a'] = [assistant(40, 10, 0.1)]
    const made = await store.createFragment({ name: 'Weigh me', html: '<p>12345</p>' })
    await store.writeFragmentFile(made.id, 'style.css', 'body{}')
    await store.storeSet(made.id, 'notes', { a: 1 })

    const found = await details.getFragmentDetails(made.id)
    expect(found?.files.map((f) => f.path)).toEqual(['index.html', 'style.css'])
    expect(found?.srcBytes).toBe(12 + 6)
    expect(found?.dataKeys).toEqual([{ key: 'notes', bytes: 7 }])
    expect(found?.tokens).toMatchObject({ chats: 1, input: 40, output: 10 })
    expect(found?.provenance.origin).toBe('local')
    expect(found?.packages).toEqual([])
  })

  it('shows the stored data read-only, key by key, and clips what is huge', async () => {
    const made = await store.createFragment({ name: 'Data view', html: '<p>x</p>' })
    await store.storeSet(made.id, 'small', { a: [1, 2] })
    await store.storeSet(made.id, 'big', 'x'.repeat(30_000))
    const entries = await details.getFragmentData(made.id)
    expect(entries?.map((e) => e.key)).toEqual(['big', 'small'])
    expect(entries?.[0]).toMatchObject({ truncated: true, bytes: 30_002 })
    expect(entries?.[0].json.length).toBe(20_000)
    expect(entries?.[1]).toMatchObject({ truncated: false, json: '{\n  "a": [\n    1,\n    2\n  ]\n}' })
  })

  it('returns null for a fragment that does not exist', async () => {
    expect(await details.getFragmentDetails('frag-nope-000000')).toBeNull()
    expect(await details.getFragmentData('frag-nope-000000')).toBeNull()
  })
})
