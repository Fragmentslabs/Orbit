import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const userData = path.join(os.tmpdir(), `orbit-agent-gen-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))

let generator: typeof import('./generator')
let createAgent: typeof import('../tools/create-agent')

beforeAll(async () => {
  generator = await import('./generator')
  createAgent = await import('../tools/create-agent')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('agentSuggestionFrom', () => {
  const draft = { name: 'Contract reviewer', icon: 'scale', whenToUse: 'Reviewing contracts.', prompt: 'Review contracts.' }

  it('accepts a good draft and keeps only pinned skills that exist', () => {
    const out = generator.agentSuggestionFrom({ ...draft, pinnedSkills: ['real', 'made_up'] }, ['real'])
    expect(out?.pinnedSkills).toEqual(['real'])
    expect(out?.name).toBe('Contract reviewer')
  })

  it('refuses a draft with no name or no prompt', () => {
    expect(generator.agentSuggestionFrom({ ...draft, name: '' }, [])).toBeNull()
    expect(generator.agentSuggestionFrom({ ...draft, prompt: '   ' }, [])).toBeNull()
  })

  it('cannot slip in an unknown craft or a switch that is not a literal true', () => {
    const out = generator.agentSuggestionFrom({ ...draft, craft: 'browser', features: { loop: 'yes', vision: true } }, [])
    expect(out?.craft).toBeUndefined()
    expect(out?.features.loop).toBe(false)
    expect(out?.features.vision).toBe(true)
  })
})

describe('create_agent tool', () => {
  const run = (args: Record<string, unknown>) =>
    (createAgent.createAgentTool() as unknown as { execute: (a: unknown) => Promise<string> }).execute(args)

  it('only proposes: it reports the card and saves nothing', async () => {
    const text = await run({ name: 'Reviewer', whenToUse: 'Reviewing.', prompt: 'Review.', pinnedSkills: ['ghost'] })
    expect(text).toContain('proposed')
    expect(text).toContain('ghost')
    const store = await import('./store')
    expect(await store.loadAgents()).toEqual([])
  })

  it('says what is missing instead of proposing an unusable agent', async () => {
    expect(await run({ name: 'No prompt', whenToUse: 'x', prompt: '' })).toContain('needs a prompt')
    expect(await run({ name: '', whenToUse: 'x', prompt: 'p' })).toContain('needs a name')
  })
})
