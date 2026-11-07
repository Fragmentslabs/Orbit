import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { StorageKeys, specialistProfileOf, type SendMessageInput, type SessionInfo } from '@shared/chat'

/**
 * Specialist profiles beyond the fragment: motion and design run a lean chat of their craft —
 * the profile is read from the session on disk, the prompt carries the craft, and the toolset
 * is the craft's tools only.
 */

const userData = path.join(os.tmpdir(), `orbit-profiles-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

let profiles: typeof import('./index')
let storage: typeof import('../storage')
let prompts: typeof import('../prompts')
let tools: typeof import('../tools/index')

beforeAll(async () => {
  profiles = await import('./index')
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

function input(sessionId: string, profile?: 'motion' | 'design'): SendMessageInput {
  return {
    sessionId,
    mode: 'chat',
    text: 'hi',
    providerId: 'p',
    modelId: 'm',
    options: profile ? { profile } : {},
  } as unknown as SendMessageInput
}

describe('specialistProfileOf', () => {
  it('reads both the fragment field and the profile field', () => {
    expect(specialistProfileOf(session('a', { fragment: { kind: 'screen' } }))).toBe('fragment')
    expect(specialistProfileOf(session('b', { profile: 'motion' }))).toBe('motion')
    expect(specialistProfileOf(session('d', { profile: 'fragment' }))).toBe('fragment')
    expect(specialistProfileOf(session('c'))).toBeNull()
    expect(specialistProfileOf(null)).toBeNull()
  })
})

describe('profileOf', () => {
  it('is decided from the session on disk', async () => {
    await storage.writeJson(StorageKeys.session('s-motion'), session('s-motion', { profile: 'motion' }))
    await storage.writeJson(StorageKeys.session('s-design'), session('s-design', { profile: 'design' }))
    await storage.writeJson(StorageKeys.session('s-plain'), session('s-plain'))
    expect(await profiles.profileOf('s-motion')).toBe('motion')
    expect(await profiles.profileOf('s-design')).toBe('design')
    expect(await profiles.profileOf('s-plain')).toBeNull()
    expect(await profiles.profileOf('s-missing')).toBeNull()
  })

  it('leaves the options of a specialist turn lean', () => {
    const lean = profiles.leanOptions({ research: true, browser: true, subagents: true, plan: true }, 'motion')
    expect(lean.profile).toBe('motion')
    expect(lean.research).toBe(false)
    expect(lean.browser).toBe(false)
    expect(lean.subagents).toBe(false)
    expect(lean.plan).toBe(false)
  })
})

describe('motion and design prompts', () => {
  it('carry the craft and are shorter than a general chat prompt', async () => {
    const motion = await prompts.buildSystemPrompt(input('s-motion', 'motion'))
    const design = await prompts.buildSystemPrompt(input('s-design', 'design'))
    const normal = await prompts.buildSystemPrompt(input('s-plain'))
    expect(motion).toContain('motion_write')
    expect(design).toContain('design_write')
    expect(motion.length).toBeLessThan(normal.length)
    expect(design.length).toBeLessThan(normal.length)
    expect(motion.toLowerCase()).not.toContain('memory')
  })
})

describe('motion and design toolsets', () => {
  it('give a motion chat motion tools and no design tools', () => {
    const names = Object.keys(tools.buildToolSet(input('s-motion', 'motion'), null))
    expect(names).toContain('motion_write')
    expect(names.some((n) => n.startsWith('design_'))).toBe(false)
    expect(names).not.toContain('bash')
  })

  it('give a design chat design tools and no motion tools', () => {
    const names = Object.keys(tools.buildToolSet(input('s-design', 'design'), null))
    expect(names).toContain('design_write')
    expect(names.some((n) => n.startsWith('motion_'))).toBe(false)
  })
})

describe('turn blocks', () => {
  it('tell a motion chat with no composition to create one, then list what exists', async () => {
    expect(await profiles.profileTurnBlock('motion', 'blank')).toContain('motion_write')
    const dir = (await import('../tools/motion')).motionPiecesDir('with-pieces')
    await fsp.mkdir(path.join(dir, 'logo-intro'), { recursive: true })
    expect(await profiles.profileTurnBlock('motion', 'with-pieces')).toContain('logo-intro')
  })

  it('does the same for design', async () => {
    expect(await profiles.profileTurnBlock('design', 'blank')).toContain('design_write')
    const dir = (await import('../tools/design')).designPiecesDir('with-pieces')
    await fsp.mkdir(path.join(dir, 'landing'), { recursive: true })
    expect(await profiles.profileTurnBlock('design', 'with-pieces')).toContain('landing')
  })
})
