import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { StorageKeys, type SendMessageInput, type SessionInfo } from '@shared/chat'

/**
 * The lean profile of a fragment's own chat: it is decided from the session on disk, the
 * prompt is the fragment prompt alone, and the toolset is the fragment tools alone.
 */

const userData = path.join(os.tmpdir(), `orbit-fragment-profile-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

let profile: typeof import('./fragment-profile')
let store: typeof import('./fragment-store')
let storage: typeof import('../storage')
let prompts: typeof import('../prompts')
let tools: typeof import('../tools/index')

beforeAll(async () => {
  profile = await import('./fragment-profile')
  store = await import('./fragment-store')
  storage = await import('../storage')
  prompts = await import('../prompts')
  tools = await import('../tools/index')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

function session(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, title: 't', mode: 'chat', pinned: false, archived: false, folderId: null, createdAt: 1, updatedAt: 1, ...extra }
}

function input(sessionId: string, fragment: boolean): SendMessageInput {
  return {
    sessionId,
    mode: 'chat',
    text: 'hi',
    providerId: 'p',
    modelId: 'm',
    options: fragment ? { profile: 'fragment' } : {},
  } as unknown as SendMessageInput
}

describe('fragment profile', () => {
  it('recognises a fragment chat from the session on disk, and only that', async () => {
    await storage.writeJson(StorageKeys.session('sess-frag'), session('sess-frag', { fragment: { kind: 'panel' } }))
    await storage.writeJson(StorageKeys.session('sess-plain'), session('sess-plain'))
    expect(await profile.fragmentProfileOf('sess-frag')).toEqual({ kind: 'panel' })
    expect(await profile.fragmentProfileOf('sess-plain')).toBeNull()
    expect(await profile.fragmentProfileOf('sess-missing')).toBeNull()
  })

  it('tells a chat with no fragment yet to create one of the asked kind', async () => {
    await storage.writeJson(StorageKeys.session('sess-new'), session('sess-new', { fragment: { kind: 'widget' } }))
    const block = await profile.fragmentTurnBlock('sess-new')
    expect(block).toContain('fragment_create')
    expect(block).toContain('widget')
  })

  it('orients a chat that already owns a fragment: which one, its files, what was asked', async () => {
    await storage.writeJson(StorageKeys.session('sess-own'), session('sess-own', { fragment: { kind: 'screen' } }))
    const m = await store.createFragment({ name: 'Owned', html: '<p>x</p>', requests: ['ai'], sessionId: 'sess-own' })
    await store.writeFragmentFile(m.id, 'style.css', 'p{}')
    const block = await profile.fragmentTurnBlock('sess-own')
    expect(block).toContain(m.id)
    expect(block).toContain('index.html')
    expect(block).toContain('style.css')
    expect(block).toContain('ai')
  })

  it('uses the fragment prompt alone — short, and nothing about memories, folders or browsing', async () => {
    const lean = await prompts.buildSystemPrompt(input('sess-frag', true))
    const normal = await prompts.buildSystemPrompt(input('sess-plain', false))
    expect(lean).toBe(profile.fragmentSystemPrompt(undefined))
    expect(lean).toContain('fragment_create')
    expect(lean.length).toBeLessThan(normal.length)
    expect(lean.toLowerCase()).not.toContain('memory')
  })

  it('gives a fragment chat the fragment tools and nothing else', () => {
    const lean = Object.keys(tools.buildToolSet(input('sess-frag', true), null))
    expect(lean.length).toBeGreaterThan(0)
    expect(lean.every((name) => name.startsWith('fragment_'))).toBe(true)
    const normal = Object.keys(tools.buildToolSet(input('sess-plain', false), null))
    expect(normal.some((name) => !name.startsWith('fragment_'))).toBe(true)
  })
})
