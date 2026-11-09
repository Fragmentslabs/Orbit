import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENT_LIMITS } from '@shared/agents'

const userData = path.join(os.tmpdir(), `orbit-overrides-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

let validate: typeof import('./validate')
let overrides: typeof import('./overrides')
let profiles: typeof import('../profiles/index')
let describe_: typeof import('../profiles/describe')

beforeAll(async () => {
  validate = await import('./validate')
  overrides = await import('./overrides')
  profiles = await import('../profiles/index')
  describe_ = await import('../profiles/describe')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('whenToUse and pinned skills', () => {
  it('start empty and are clamped and filtered', () => {
    expect(validate.sanitizeAgentInput({ name: 'A' })).toMatchObject({ whenToUse: '', pinnedSkills: [] })
    const out = validate.sanitizeAgentInput({
      name: 'A',
      whenToUse: `  review\n${'x'.repeat(1000)}`,
      pinnedSkills: ['ok_one', 'ok_one', 'Bad Slug', 42, '../etc', ...Array.from({ length: 40 }, (_, i) => `s${i}`)],
    })
    expect(out.whenToUse.length).toBeLessThanOrEqual(AGENT_LIMITS.whenToUse)
    expect(out.whenToUse).not.toContain('\n')
    expect(out.pinnedSkills.slice(0, 2)).toEqual(['ok_one', 's0'])
    expect(out.pinnedSkills.length).toBeLessThanOrEqual(AGENT_LIMITS.pinnedSkills)
  })
})

describe('built-in overrides', () => {
  it('layers on the shipped definition, and restoring brings the default back', async () => {
    await overrides.loadOverrides()
    const shipped = profiles.resolveProfile('motion')!.systemPrompt({})
    expect(describe_.describeBuiltins().find((b) => b.id === 'motion')?.edited).toBe(false)

    expect(await overrides.saveOverride('motion', { prompt: 'Be brief.', whenToUse: 'Only for logos.' })).toBe(true)
    const edited = profiles.resolveProfile('motion')!
    expect(edited.systemPrompt({})).toBe('Be brief.')
    expect(edited.whenToUse).toBe('Only for logos.')
    // The craft itself is untouched: same tools, same blocks.
    expect(edited.tools).toBeDefined()
    expect(describe_.describeBuiltins().find((b) => b.id === 'motion')?.edited).toBe(true)

    await overrides.resetOverride('motion')
    expect(profiles.resolveProfile('motion')!.systemPrompt({})).toBe(shipped)
  })

  it('refuses ids that are not built-ins and survives a reload', async () => {
    expect(await overrides.saveOverride('agent:x', { prompt: 'no' })).toBe(false)
    await overrides.saveOverride('design', { whenToUse: 'Posters.' })
    overrides.resetOverrideCache()
    await overrides.loadOverrides()
    expect(overrides.getOverrideSync('design')).toEqual({ whenToUse: 'Posters.' })
  })
})

describe('craft agents and templates', () => {
  it('a craft agent keeps the craft tools and blocks but speaks with its own words', async () => {
    const store = await import('./store')
    const saved = await store.saveAgent({ name: 'Logo motion', craft: 'motion', prompt: 'Only logo stings.', whenToUse: 'Logo animations.', pinnedSkills: [] })
    if (!saved.ok) throw new Error('save failed')
    const def = profiles.resolveProfile(`agent:${saved.agent.id}`)!
    expect(def.systemPrompt({})).toBe('Only logo stings.')
    expect(def.tools).toBeDefined()
    expect(def.blocks.memories).toBe(false)
    expect(def.turnBlock).toBeDefined()
    // An invalid craft is dropped, never trusted.
    expect(validate.sanitizeAgentInput({ name: 'x', craft: 'browser' }).craft).toBeUndefined()
  })

  it('every template is a valid agent', async () => {
    const { AGENT_TEMPLATE_IDS, agentFromTemplate } = await import('@shared/agent-templates')
    for (const id of AGENT_TEMPLATE_IDS) {
      const input = agentFromTemplate(id, 'Name')
      expect(validate.agentInputProblem(validate.sanitizeAgentInput(input))).toBeNull()
      expect(input.prompt.length).toBeGreaterThan(0)
      expect(input.whenToUse.length).toBeGreaterThan(0)
    }
  })
})
