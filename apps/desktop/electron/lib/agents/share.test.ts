import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_FILE_MAX_BYTES } from '@shared/agent-share'
import { AGENT_FORMAT_VERSION, AGENT_LIMITS } from '@shared/agents'

const userData = path.join(os.tmpdir(), `orbit-agent-share-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

let share: typeof import('./share')
let store: typeof import('./store')

beforeAll(async () => {
  share = await import('./share')
  store = await import('./store')
})

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
  store.resetAgentCache()
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

const file = (agent: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'orbit-agent', version: AGENT_FORMAT_VERSION, agent, ...extra })

const powerful = {
  name: 'Researcher',
  icon: 'brain',
  prompt: 'Research everything.',
  whenToUse: 'when asked to research',
  pinnedSkills: ['web_research'],
  features: { vision: true, subagents: true, orchestra: false, loop: true, memories: true },
  allowedTools: ['web_search', 'read_file'],
  craft: 'motion',
}

describe('export', () => {
  it('writes the definition without id, dates, origin, model or thinking', async () => {
    const saved = await store.saveAgent({ ...powerful, defaultModel: { providerId: 'p', modelId: 'm' }, thinking: true })
    if (!saved.ok) throw new Error('save failed')
    const { text, suggestedName } = share.serializeAgent(saved.agent)
    expect(suggestedName).toBe('researcher.orbitagent')
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({ format: 'orbit-agent', version: AGENT_FORMAT_VERSION })
    expect(parsed.agent).toMatchObject({ name: 'Researcher', allowedTools: ['web_search', 'read_file'], craft: 'motion' })
    for (const key of ['id', 'createdAt', 'updatedAt', 'origin', 'defaultModel', 'thinking']) expect(parsed.agent).not.toHaveProperty(key)
  })

  it('round trips through preview and confirm', async () => {
    const saved = await store.saveAgent(powerful)
    if (!saved.ok) throw new Error('save failed')
    const preview = share.previewAgentImport('r.orbitagent', share.serializeAgent(saved.agent).text)
    expect(preview.ok && preview.preview.agent).toMatchObject(powerful)
  })
})

describe('preview (the consent card)', () => {
  it('returns everything the agent will do and saves nothing', async () => {
    const result = share.previewAgentImport('/x/r.orbitagent', file(powerful))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { agent } = result.preview
    expect(agent.prompt).toBe('Research everything.')
    expect(agent.pinnedSkills).toEqual(['web_research'])
    expect(agent.features).toEqual(powerful.features)
    expect(agent.allowedTools).toEqual(['web_search', 'read_file'])
    expect(agent.whenToUse).toBe('when asked to research')
    expect(result.preview.fileName).toBe('r.orbitagent')
    expect(await store.loadAgents()).toEqual([])
  })

  it('reports and drops the model and thinking defaults', () => {
    const result = share.previewAgentImport('a', file({ ...powerful, defaultModel: { providerId: 'p', modelId: 'm' }, thinking: true }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.ignored).toEqual(['defaultModel', 'thinking'])
    expect(result.preview.agent).not.toHaveProperty('defaultModel')
    expect(result.preview.agent).not.toHaveProperty('thinking')
  })

  it('cleans what the file claims with the editor rules: unknown features and tools never slip in', () => {
    const result = share.previewAgentImport('a', file({
      name: 'Sneaky', features: { vision: 'yes', loop: 1, web: true, computer: true }, allowedTools: ['ok_tool', '../bad', 7],
      pinnedSkills: ['good_skill', 'Bad Skill!'], icon: 'skull', id: 'ag_chosen', origin: 'user',
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.agent.features).toEqual({ vision: false, subagents: false, orchestra: false, loop: false, memories: false })
    expect(result.preview.agent.allowedTools).toEqual(['ok_tool'])
    expect(result.preview.agent.pinnedSkills).toEqual(['good_skill'])
    expect(result.preview.agent.icon).toBe('bot')
  })

  it.each([
    ['not json', '{nope', 'not_json'],
    ['an array', '[]', 'bad_format'],
    ['another format', JSON.stringify({ format: 'orbitfrag', version: 1, agent: { name: 'A' } }), 'bad_format'],
    ['a missing version', JSON.stringify({ format: 'orbit-agent', agent: { name: 'A' } }), 'bad_format'],
    ['a newer version', file({ name: 'A' }, { version: AGENT_FORMAT_VERSION + 1 }), 'unsupported_version'],
    ['no agent', JSON.stringify({ format: 'orbit-agent', version: 1 }), 'bad_agent'],
    ['a nameless agent', file({ name: '   ', prompt: 'x' }), 'bad_agent'],
  ])('refuses %s', (_label, text, code) => {
    expect(share.previewAgentImport('a', text)).toEqual({ ok: false, code })
  })

  it('refuses non-text and oversized files', () => {
    expect(share.previewAgentImport('a', 42)).toEqual({ ok: false, code: 'not_json' })
    expect(share.previewAgentImport('a', 'x'.repeat(AGENT_FILE_MAX_BYTES + 1))).toEqual({ ok: false, code: 'too_large' })
  })

  it('clamps an enormous prompt instead of trusting its size', () => {
    const result = share.previewAgentImport('a', file({ name: 'Big', prompt: 'p'.repeat(AGENT_LIMITS.prompt + 5000) }))
    expect(result.ok && result.preview.agent.prompt.length).toBe(AGENT_LIMITS.prompt)
  })
})

describe('confirm', () => {
  it('saves only on confirmation, as imported, with exactly the features shown', async () => {
    const result = share.previewAgentImport('a', file(powerful))
    if (!result.ok) throw new Error('preview failed')
    expect(await store.loadAgents()).toEqual([])

    const done = await share.confirmAgentImport(result.preview.token)
    expect(done.ok).toBe(true)
    const [agent] = await store.loadAgents()
    expect(agent).toMatchObject({ name: 'Researcher', origin: 'imported', features: powerful.features, allowedTools: ['web_search', 'read_file'] })
    expect(agent.defaultModel).toBeUndefined()
    expect(agent.id).toMatch(/^ag_[0-9a-f]{16}$/)
  })

  it('cannot choose its id or origin, even if the file says so', async () => {
    const result = share.previewAgentImport('a', file({ ...powerful, id: 'ag_chosen', origin: 'user' }))
    if (!result.ok) throw new Error('preview failed')
    await share.confirmAgentImport(result.preview.token)
    const [agent] = await store.loadAgents()
    expect(agent.id).not.toBe('ag_chosen')
    expect(agent.origin).toBe('imported')
  })

  it('needs the token of a preview: nothing is saved without one, and a token works once', async () => {
    expect(await share.confirmAgentImport('made-up')).toEqual({ ok: false, code: 'expired' })
    expect(await share.confirmAgentImport(undefined)).toEqual({ ok: false, code: 'expired' })
    const result = share.previewAgentImport('a', file(powerful))
    if (!result.ok) throw new Error('preview failed')
    await share.confirmAgentImport(result.preview.token)
    expect(await share.confirmAgentImport(result.preview.token)).toEqual({ ok: false, code: 'expired' })
    expect(await store.loadAgents()).toHaveLength(1)
  })

  it('a cancelled card saves nothing', async () => {
    const result = share.previewAgentImport('a', file(powerful))
    if (!result.ok) throw new Error('preview failed')
    share.cancelAgentImport(result.preview.token)
    expect((await share.confirmAgentImport(result.preview.token)).ok).toBe(false)
    expect(await store.loadAgents()).toEqual([])
  })

  it('respects the cap on agents', async () => {
    for (let i = 0; i < AGENT_LIMITS.agents; i++) await store.saveAgent({ name: `A${i}` })
    const result = share.previewAgentImport('a', file(powerful))
    if (!result.ok) throw new Error('preview failed')
    expect(await share.confirmAgentImport(result.preview.token)).toEqual({ ok: false, code: 'limit' })
  })

  it('a copy of an imported agent is the person\'s own', async () => {
    const result = share.previewAgentImport('a', file(powerful))
    if (!result.ok) throw new Error('preview failed')
    const done = await share.confirmAgentImport(result.preview.token)
    if (!done.ok) throw new Error('confirm failed')
    const copy = await store.duplicateAgent(done.agentId, 'copy')
    expect(copy.ok && copy.agent.origin).toBe('user')
  })
})
