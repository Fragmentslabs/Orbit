import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENT_LIMITS, userProfileId, type AgentInput } from '@shared/agents'
import { StorageKeys, type SendMessageInput, type SessionInfo } from '@shared/chat'

const userData = path.join(os.tmpdir(), `orbit-agents-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

let store: typeof import('./store')
let validate: typeof import('./validate')
let profiles: typeof import('../profiles/index')
let describe_: typeof import('../profiles/describe')
let prompts: typeof import('../prompts')
let tools: typeof import('../tools/index')
let storage: typeof import('../storage')

beforeAll(async () => {
  store = await import('./store')
  validate = await import('./validate')
  profiles = await import('../profiles/index')
  describe_ = await import('../profiles/describe')
  prompts = await import('../prompts')
  tools = await import('../tools/index')
  storage = await import('../storage')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

const draft = (extra: Partial<AgentInput> = {}) => ({ name: 'Reviewer', icon: 'code', prompt: 'Review code.', ...extra })

describe('sanitizeAgentInput', () => {
  it('starts empty: every feature off, no tools or model', () => {
    const out = validate.sanitizeAgentInput({ name: 'A' })
    expect(out.prompt).toBe('')
    expect(Object.values(out.features).every((v) => v === false)).toBe(true)
    expect(out.allowedTools).toBeUndefined()
    expect(out.defaultModel).toBeUndefined()
  })

  it('only a literal true switches a feature on', () => {
    const out = validate.sanitizeAgentInput({ name: 'A', features: { vision: true, loop: 'yes', memories: 1, subagents: false } })
    expect(out.features).toEqual({ vision: true, subagents: false, orchestra: false, loop: false, memories: false })
  })

  it('clamps sizes, drops unknown icons and control characters, and filters tool names', () => {
    const out = validate.sanitizeAgentInput({
      name: `  ${'x'.repeat(200)}\u0000  `,
      icon: 'not-an-icon',
      prompt: 'p'.repeat(AGENT_LIMITS.prompt + 50),
      allowedTools: ['read', 'read', 'bad name!', 42, 'grep'],
    })
    expect(out.name.length).toBe(AGENT_LIMITS.name)
    expect(out.name).not.toContain('\u0000')
    expect(out.icon).toBe('bot')
    expect(out.prompt.length).toBe(AGENT_LIMITS.prompt)
    expect(out.allowedTools).toEqual(['read', 'grep'])
  })

  it('requires a name', () => {
    expect(validate.agentInputProblem(validate.sanitizeAgentInput({ name: '   ' }))).toBe('name')
  })
})

describe('agent store', () => {
  it('creates, edits, duplicates and deletes, and survives a reload', async () => {
    const created = await store.saveAgent(draft())
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.agent.id

    const edited = await store.saveAgent(draft({ name: 'Reviewer 2', features: { vision: true, subagents: false, orchestra: false, loop: false, memories: false } }), id)
    expect(edited.ok && edited.agent.name).toBe('Reviewer 2')
    expect(edited.ok && edited.agent.createdAt).toBe(created.agent.createdAt)

    const copy = await store.duplicateAgent(id, 'copy')
    expect(copy.ok && copy.agent.name).toBe('Reviewer 2 copy')
    expect(copy.ok && copy.agent.id).not.toBe(id)

    store.resetAgentCache()
    const reloaded = await store.loadAgents()
    expect(reloaded.map((a) => a.name)).toEqual(['Reviewer 2', 'Reviewer 2 copy'])

    expect(await store.removeAgent(id)).toBe(true)
    expect(await store.removeAgent(id)).toBe(false)
    expect((await store.loadAgents()).map((a) => a.name)).toEqual(['Reviewer 2 copy'])
  })

  it('refuses a nameless agent, an unknown id, and more than the cap', async () => {
    expect(await store.saveAgent(draft({ name: '' }))).toEqual({ ok: false, reason: 'name' })
    expect(await store.saveAgent(draft(), 'nope')).toEqual({ ok: false, reason: 'missing' })
    const room = AGENT_LIMITS.agents - (await store.loadAgents()).length
    for (let i = 0; i < room; i++) await store.saveAgent(draft({ name: `n${i}` }))
    expect(await store.saveAgent(draft())).toEqual({ ok: false, reason: 'limit' })
  })

  it('drops invalid records from a damaged file', async () => {
    await storage.writeJson('agents', { agents: [{ id: 'ok_1', name: 'Fine', prompt: 'x' }, { id: '../evil', name: 'Bad' }, { id: 'no_name', name: '' }, 'junk'] })
    store.resetAgentCache()
    expect((await store.loadAgents()).map((a) => a.id)).toEqual(['ok_1'])
  })
})

function session(id: string, profile: SessionInfo['profile']): SessionInfo {
  return { id, title: 't', mode: 'chat', pinned: false, archived: false, folderId: null, createdAt: 1, updatedAt: 1, profile }
}
const turn = (sessionId: string, options: SendMessageInput['options'] = {}) =>
  ({ sessionId, mode: 'chat', text: 'hi', providerId: 'p', modelId: 'm', options }) as unknown as SendMessageInput

describe('a user-made agent as a profile', () => {
  let agentId = ''
  beforeAll(async () => {
    await storage.writeJson('agents', { agents: [] })
    store.resetAgentCache()
    const saved = await store.saveAgent(draft({ prompt: 'You are terse.' }))
    if (saved.ok) agentId = saved.agent.id
    await storage.writeJson(StorageKeys.session('s-agent'), session('s-agent', userProfileId(agentId)))
    await storage.writeJson(StorageKeys.session('s-gone'), session('s-gone', userProfileId('deleted')))
  })

  it('is found from the session; an unknown agent falls back to the general chat', async () => {
    expect(await profiles.profileOf('s-agent')).toBe(userProfileId(agentId))
    expect(await profiles.profileOf('s-gone')).toBeNull()
  })

  it('uses its prompt as the whole system prompt', async () => {
    const input = turn('s-agent', { profile: userProfileId(agentId) })
    expect(await prompts.buildSystemPrompt(input)).toBe('You are terse.')
  })

  it('switches every feature off by default and never turns anything on', () => {
    const asked = turn('s-agent', { brain: true, brainContext: true, subagents: true, loop: true, orchestrate: {}, research: true, plan: true })
    const out = profiles.restrictInput({ ...asked, visionModel: { providerId: 'p', modelId: 'v' } } as SendMessageInput, userProfileId(agentId))
    expect(out.options).toMatchObject({ brain: false, brainContext: false, subagents: false, research: true, plan: true })
    expect(out.options.loop).toBeUndefined()
    expect(out.options.orchestrate).toBeUndefined()
    expect(out.visionModel).toBeUndefined()
    // Nothing the person did not ask for appears.
    const bare = profiles.restrictInput(turn('s-agent'), userProfileId(agentId))
    expect(bare.options.research).toBeUndefined()
    expect(bare.options.brain).toBe(false)
  })

  it('keeps a feature the agent switched on, still under the conversation toggles', async () => {
    const saved = await store.saveAgent(draft({ name: 'Rich', features: { vision: true, subagents: true, orchestra: true, loop: true, memories: true } }))
    const id = saved.ok ? saved.agent.id : ''
    const out = profiles.restrictInput(turn('x', { brain: true, subagents: true, loop: true }), userProfileId(id))
    expect(out.options).toMatchObject({ brain: true, subagents: true, loop: true })
    // On does not mean forced on: what the conversation did not ask for stays off.
    expect(profiles.restrictInput(turn('x'), userProfileId(id)).options.brain).toBeUndefined()
  })

  it('removes the Orbit machinery from the toolset and honours an allowlist', async () => {
    const id = userProfileId(agentId)
    const names = Object.keys(tools.buildToolSet(turn('s-agent', { profile: id, research: true }), null))
    expect(names).toContain('websearch')
    for (const gone of ['skill_read', 'routines_manage', 'pipeline_create', 'chat_search', 'hook_create', 'subagent']) {
      expect(names).not.toContain(gone)
    }
    const narrowed = await store.saveAgent(draft({ name: 'Narrow', allowedTools: ['websearch'] }))
    const narrowId = userProfileId(narrowed.ok ? narrowed.agent.id : '')
    const only = Object.keys(tools.buildToolSet(turn('s-agent', { profile: narrowId, research: true }), null))
    expect(only).toEqual(['websearch'])
  })
})

describe('describeBuiltins', () => {
  it('lists the three crafts with the prompt, tools and blocks the engine really uses', () => {
    const list = describe_.describeBuiltins()
    expect(list.map((p) => p.id)).toEqual(['fragment', 'motion', 'design'])
    const motion = list.find((p) => p.id === 'motion')!
    expect(motion.tools).toContain('motion_write')
    expect(motion.systemPrompt).toContain('motion_write')
    expect(motion.blocks.memories).toBe(false)
    expect(motion.turnContext).toBeTruthy()
    const real = Object.keys(tools.buildToolSet(turn('s', { profile: 'motion' }), null)).sort()
    expect(real).toEqual(expect.arrayContaining(motion.tools.filter((n) => n !== 'audio_generate')))
  })
})
