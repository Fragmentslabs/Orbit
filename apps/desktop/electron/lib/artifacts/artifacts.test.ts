import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'
import { isEmbeddedArtifactChat } from '@shared/artifacts'

/**
 * The generic artifact layer: which chats worked on an artifact (one registry for every
 * kind), the tracking at the tool boundary, and the sidebar rule for embedded chats.
 */

const userData = path.join(os.tmpdir(), `orbit-artifacts-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
}))
vi.mock('../video/motion-store', () => ({
  motionIdForName: async (sessionId: string, name: string) => (name === 'intro' ? `mv_${sessionId}_${name}` : null),
  getMotion: async (id: string) => (id.startsWith('mv_') ? { folder: `/pieces/${id}/intro`, entry: '/x', createdAt: 1 } : undefined),
}))
vi.mock('../design/design-store', () => ({
  designIdForName: async (sessionId: string, name: string) => (name === 'landing' ? `dz_${sessionId}_${name}` : null),
  getDesign: async (id: string) => (id.startsWith('dz_') ? { folder: `/pieces/${id}/landing`, createdAt: 1 } : undefined),
}))

let registry: typeof import('./chat-registry')
let tracking: typeof import('./tracking')
let describeMod: typeof import('./describe')
let fragmentStore: typeof import('../fragments/fragment-store')

beforeAll(async () => {
  registry = await import('./chat-registry')
  tracking = await import('./tracking')
  describeMod = await import('./describe')
  fragmentStore = await import('../fragments/fragment-store')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('artifact chat registry', () => {
  const ref = { kind: 'fragment', id: 'frag-a-1' } as const

  it('starts empty and makes the first chat current without stealing it later', async () => {
    expect(await registry.listArtifactChats(ref)).toEqual({ sessionIds: [], current: undefined })
    await registry.associateChat(ref, 's1')
    await registry.associateChat(ref, 's2')
    expect(await registry.listArtifactChats(ref)).toEqual({ sessionIds: ['s1', 's2'], current: 's1' })
  })

  it('lists a chat once, and lets the person pick the current one', async () => {
    await registry.associateChat(ref, 's1')
    await registry.setCurrentChat(ref, 's2')
    const chats = await registry.listArtifactChats(ref)
    expect(chats.sessionIds).toEqual(['s1', 's2'])
    expect(chats.current).toBe('s2')
  })

  it('does not lose a chat when two finish a tool at the same time', async () => {
    const other = { kind: 'motion', id: 'mv_race' } as const
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => registry.associateChat(other, id)))
    expect((await registry.listArtifactChats(other)).sessionIds.sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps the kinds apart and refuses an unsafe id', async () => {
    expect((await registry.listArtifactChats({ kind: 'design', id: 'frag-a-1' })).sessionIds).toEqual([])
    await expect(registry.listArtifactChats({ kind: 'fragment', id: '../etc' })).rejects.toThrow(/invalid/)
  })
})

describe('artifact tracking', () => {
  const tool = (result: unknown | Error) =>
    ({ description: 'x', execute: async () => (result instanceof Error ? Promise.reject(result) : result) }) as never
  const run = (tools: ToolSet, name: string, args: unknown) =>
    (tools[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

  it('records the chat that created or changed a fragment, a motion piece and a design canvas', async () => {
    const tools = tracking.withArtifactTracking(
      {
        fragment_create: tool({ fragmentId: 'frag-new-1', message: 'ok' }),
        fragment_edit_file: tool('edited'),
        motion_write: tool('ok'),
        design_edit: tool('ok'),
      },
      { sessionId: 'chat-x' },
    )
    await run(tools, 'fragment_create', { name: 'New' })
    await run(tools, 'fragment_edit_file', { fragmentId: 'frag-new-1', path: 'a.css' })
    await run(tools, 'motion_write', { name: 'intro' })
    await run(tools, 'design_edit', { name: 'landing' })
    expect((await registry.listArtifactChats({ kind: 'fragment', id: 'frag-new-1' })).sessionIds).toEqual(['chat-x'])
    expect((await registry.listArtifactChats({ kind: 'motion', id: 'mv_chat-x_intro' })).sessionIds).toEqual(['chat-x'])
    expect((await registry.listArtifactChats({ kind: 'design', id: 'dz_chat-x_landing' })).sessionIds).toEqual(['chat-x'])
  })

  it('reaches a piece by the id argument when the chat is not its owner', async () => {
    const tools = tracking.withArtifactTracking({ motion_edit: tool('ok'), motion_write: tool('ok') }, { sessionId: 'chat-y' })
    await run(tools, 'motion_write', { id: 'mv_elsewhere' })
    expect((await registry.listArtifactChats({ kind: 'motion', id: 'mv_elsewhere' })).sessionIds).toEqual(['chat-y'])
  })

  it('never changes what a tool returns, nor fails because of the bookkeeping', async () => {
    const tools = tracking.withArtifactTracking({ motion_write: tool('written') }, { sessionId: 'chat-z' })
    expect(await run(tools, 'motion_write', { name: 'unknown-name' })).toBe('written')
  })

  it('leaves tools that are not artifact tools, and a failing tool, alone', async () => {
    const plain = { description: 'x', execute: async () => 'plain' } as never
    const failing = tool(new Error('boom'))
    const tools = tracking.withArtifactTracking({ read: plain, motion_write: failing }, { sessionId: 'chat-w' })
    expect(tools.read).toBe(plain)
    await expect(run(tools, 'motion_write', { name: 'intro' })).rejects.toThrow('boom')
    expect((await registry.listArtifactChats({ kind: 'motion', id: 'mv_chat-w_intro' })).sessionIds).toEqual([])
  })
})

describe('what a chat made (the way back)', () => {
  it('indexes the artifacts of a chat once each, from the same call that lists its chats', async () => {
    await registry.associateChat({ kind: 'motion', id: 'mv_a' }, 'maker')
    await registry.associateChat({ kind: 'motion', id: 'mv_a' }, 'maker')
    await registry.associateChat({ kind: 'design', id: 'dz_b' }, 'maker')
    expect(await registry.listChatArtifacts('maker')).toEqual([
      { kind: 'motion', id: 'mv_a' },
      { kind: 'design', id: 'dz_b' },
    ])
    expect(await registry.listChatArtifacts('nobody')).toEqual([])
  })

  it('describes them for a parent, newest first, with how to reach each kind', async () => {
    const frag = await fragmentStore.createFragment({ name: 'Habit tracker', html: '<p>x</p>' })
    await registry.associateChat({ kind: 'motion', id: 'mv_desc' }, 'describer')
    await registry.associateChat({ kind: 'fragment', id: frag.id }, 'describer')
    const lines = await describeMod.describeChatArtifacts('describer')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('fragment "Habit tracker"')
    expect(lines[0]).toContain('`fragmentId`')
    expect(lines[1]).toContain('motion "intro"')
    expect(lines[1]).toContain('`id`')
    expect(lines[1]).toContain('mv_desc')
  })

  it('leaves out an artifact that no longer exists, and never throws', async () => {
    await registry.associateChat({ kind: 'fragment', id: 'frag-gone-aaaaaa' }, 'orphan')
    expect(await describeMod.describeChatArtifacts('orphan')).toEqual([])
    expect(await describeMod.describeChatArtifacts('not-a-chat')).toEqual([])
  })
})

describe('isEmbeddedArtifactChat', () => {
  it('is a chat made inside an artifact with no parent chat', () => {
    expect(isEmbeddedArtifactChat({ artifact: { kind: 'motion', id: 'mv_1' } })).toBe(true)
    expect(isEmbeddedArtifactChat({ fragment: { kind: 'screen' } })).toBe(true)
  })

  it('is false for a plain chat, a selector-made specialist chat, or an artifact subchat', () => {
    expect(isEmbeddedArtifactChat({})).toBe(false)
    expect(isEmbeddedArtifactChat({ profile: 'motion' } as never)).toBe(false)
    expect(isEmbeddedArtifactChat({ artifact: { kind: 'design' }, parentId: 'p' })).toBe(false)
  })
})
