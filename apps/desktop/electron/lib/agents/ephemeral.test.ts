import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_SECTIONS, EPHEMERAL_LIMITS, userProfileId } from '@shared/agents'
import { StorageKeys, type SendMessageInput, type SessionInfo } from '@shared/chat'

const userData = path.join(os.tmpdir(), `orbit-ephemeral-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

let ephemeral: typeof import('./ephemeral')
let store: typeof import('./store')
let validate: typeof import('./validate')
let profiles: typeof import('../profiles/index')
let describe_: typeof import('../profiles/describe')
let storage: typeof import('../storage')
let defineTool: typeof import('../tools/define-agent')
let prompts: typeof import('../prompts')

beforeAll(async () => {
  ephemeral = await import('./ephemeral')
  store = await import('./store')
  validate = await import('./validate')
  profiles = await import('../profiles/index')
  describe_ = await import('../profiles/describe')
  storage = await import('../storage')
  defineTool = await import('../tools/define-agent')
  prompts = await import('../prompts')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

const allOn = { vision: true, subagents: true, orchestra: true, loop: true, memories: true }
const raw = (extra: Record<string, unknown> = {}) => ({ name: 'Auditor', icon: 'scale', prompt: 'Audit licences.', ...extra })

describe('temporary agent definition', () => {
  it('narrows whatever it is given: no craft, pinned skills, model, sections or features', () => {
    const input = ephemeral.ephemeralInput(
      raw({ craft: 'motion', pinnedSkills: ['x'], defaultModel: { providerId: 'p', modelId: 'm' }, sections: ['visuals'], whenToUse: 'always', features: allOn }),
    )
    expect(input.craft).toBeUndefined()
    expect(input.pinnedSkills).toEqual([])
    expect(input.defaultModel).toBeUndefined()
    expect(input.sections).toBeUndefined()
    expect(input.whenToUse).toBe('')
    expect(input.features).toEqual({ vision: false, subagents: false, orchestra: false, loop: false, memories: false })
  })

  it('caps the prompt well under a saved agent’s', () => {
    expect(ephemeral.ephemeralInput(raw({ prompt: 'p'.repeat(20_000) })).prompt.length).toBe(EPHEMERAL_LIMITS.prompt)
  })

  it('refuses a nameless or promptless agent and more than the per-chat cap, without touching saved agents', async () => {
    expect(await ephemeral.defineEphemeral('owner-a', raw({ name: '' }))).toEqual({ ok: false, reason: 'name' })
    expect(await ephemeral.defineEphemeral('owner-a', raw({ prompt: '  ' }))).toEqual({ ok: false, reason: 'prompt' })
    for (let i = 0; i < EPHEMERAL_LIMITS.perSession; i++) expect((await ephemeral.defineEphemeral('owner-a', raw({ name: `A${i}` }))).ok).toBe(true)
    expect(await ephemeral.defineEphemeral('owner-a', raw())).toEqual({ ok: false, reason: 'limit' })
    // Another chat has its own allowance.
    expect((await ephemeral.defineEphemeral('owner-b', raw())).ok).toBe(true)
    expect(await store.loadAgents()).toEqual([])
  })

  it('drops damaged, widened or expired records when loading', async () => {
    const good = { id: 'eph_0123456789abcdef', ownerSessionId: 's', createdAt: Date.now(), input: { name: 'Ok', prompt: 'x', features: { vision: false } } }
    await storage.writeJson('agents-ephemeral', {
      agents: [
        good,
        { ...good, id: 'eph_1111111111111111', input: { ...good.input, craft: 'motion', pinnedSkills: ['a'], features: allOn } },
        { ...good, id: '../evil' },
        { ...good, id: 'eph_2222222222222222', createdAt: 1 },
        { ...good, id: 'eph_3333333333333333', input: { name: '', prompt: 'x' } },
      ],
    })
    ephemeral.resetEphemeralCache()
    const list = await ephemeral.loadEphemeral()
    expect(list.map((a) => a.id)).toEqual(['eph_0123456789abcdef', 'eph_1111111111111111'])
    const widened = list[1].input
    expect(widened.craft).toBeUndefined()
    expect(widened.pinnedSkills).toEqual([])
    expect(widened.features.vision).toBe(false)
  })
})

describe('define_agent tool', () => {
  const run = (owner: string, args: Record<string, unknown>) =>
    (defineTool.defineAgentTool(owner) as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute(args, {})

  it('returns the profile id for create_task and switches no feature on', async () => {
    await storage.writeJson('agents-ephemeral', { agents: [] })
    ephemeral.resetEphemeralCache()
    await ephemeral.loadEphemeral()
    const message = await run('plan-1', { name: 'Licence auditor', prompt: 'Audit licences.' })
    const id = /agent: "(agent:eph_[a-f0-9]{16})"/.exec(message)?.[1]
    expect(id).toBeTruthy()
    const found = ephemeral.ephemeralOf('plan-1')[0]
    expect(userProfileId(found.id)).toBe(id)
    expect(Object.values(found.input.features).every((on) => on === false)).toBe(true)
    expect(ephemeral.isEphemeralOf('plan-1', found.id)).toBe(true)
    // Another chat cannot send its tasks to it.
    expect(ephemeral.isEphemeralOf('plan-2', found.id)).toBe(false)
  })

  it('explains a refusal to the model', async () => {
    expect(await run('plan-x', { name: 'No prompt', prompt: '' })).toContain('needs a prompt')
  })
})

describe('a temporary agent as a profile', () => {
  let id = ''
  let profile = userProfileId('')
  beforeAll(async () => {
    await storage.writeJson('agents', { agents: [] })
    store.resetAgentCache()
    const made = await ephemeral.defineEphemeral('plan-p', raw({ prompt: 'You audit licences.', allowedTools: ['read'] }))
    if (made.ok) id = made.agent.id
    profile = userProfileId(id)
    const session: SessionInfo = { id: 'w1', title: 't', mode: 'code', pinned: false, archived: false, folderId: null, createdAt: 1, updatedAt: 1, profile }
    await storage.writeJson(StorageKeys.session('w1'), session)
  })

  it('runs as the worker’s profile with its own prompt and tool limit, and is not an agent of the person', async () => {
    expect(await profiles.profileOf('w1')).toBe(profile)
    expect(profiles.resolveProfile(profile)?.allowedTools).toEqual(['read'])
    const input = { sessionId: 'w1', mode: 'code', text: 'go', providerId: 'p', modelId: 'm', options: { profile } } as unknown as SendMessageInput
    expect(await prompts.buildSystemPrompt(input)).toBe('You audit licences.')
    expect(await store.loadAgents()).toEqual([])
  })

  it('is described like any agent, flagged temporary', () => {
    const temporary = ephemeral.resolveEphemeralSync(id)!
    const described = describe_.describeAgents([temporary], {}, new Set([id]))[profile]
    expect(described.temporary).toBe(true)
    expect(described.pieces.map((p) => p.id)).toEqual(['agent'])
  })

  it('"Save as agent" goes through the normal store; chats already running it keep working', async () => {
    const saved = await ephemeral.saveEphemeral(id)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.agent.origin).toBe('user')
    expect(saved.agent.prompt).toBe('You audit licences.')
    expect((await store.loadAgents()).map((a) => a.id)).toEqual([saved.agent.id])
    // The old id now answers as the saved agent, and it is no longer listed as temporary.
    expect(profiles.resolveProfile(profile)?.id).toBe(userProfileId(saved.agent.id))
    expect(ephemeral.ephemeralOf('plan-p')).toEqual([])
    // Saving twice does not duplicate it.
    const again = await ephemeral.saveEphemeral(id)
    expect(again.ok && again.agent.id).toBe(saved.agent.id)
    expect(await store.loadAgents()).toHaveLength(1)
    expect(await ephemeral.saveEphemeral('eph_ffffffffffffffff')).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('sections of the general prompt an agent takes', () => {
  it('keeps only known section ids, in the shared order', () => {
    const out = validate.sanitizeAgentInput({ name: 'A', sections: ['visuals', 'nope', 'identity', 42] })
    expect(out.sections).toEqual(AGENT_PROMPT_SECTIONS.filter((s) => s === 'identity' || s === 'visuals'))
    expect(validate.sanitizeAgentInput({ name: 'A', sections: ['nope'] }).sections).toBeUndefined()
  })

  it('are appended after the agent’s own prompt and priced in the description', async () => {
    const saved = await store.saveAgent(raw({ name: 'Reader', prompt: 'You read.', sections: ['documents'] }))
    const agentId = saved.ok ? saved.agent.id : ''
    const profile = userProfileId(agentId)
    const input = { sessionId: 'sec', mode: 'chat', text: 'hi', providerId: 'p', modelId: 'm', options: { profile } } as unknown as SendMessageInput
    const system = await prompts.buildSystemPrompt(input)
    expect(system.startsWith('You read.\n\n')).toBe(true)
    const documents = (await prompts.buildPromptSections(input, true)).filter((s) => s.id === 'documents').map((s) => s.text)
    expect(documents.length).toBeGreaterThan(0)
    for (const text of documents) expect(system).toContain(text)
    // Nothing else of the general prompt comes along.
    expect(system).not.toContain((await prompts.buildPromptSections(input, true)).find((s) => s.id === 'closing')!.text)
    const described = describe_.describeAgents([saved.ok ? saved.agent : (null as never)], { documents: 800 })[profile]
    expect(described.pieces).toEqual([expect.objectContaining({ id: 'agent' }), { id: 'documents', tokens: 800 }])
  })
})
