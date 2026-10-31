import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
vi.mock('electron', () => ({
  app: { getPath: () => root },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../storage', () => ({ dataDir: () => path.join(root, 'orbit-data') }))
vi.mock('../worktrees/main', () => ({ folderInMainRepository: async (f: string) => f }))
vi.mock('./builtin', () => ({ BUILTIN_SKILLS: [] }))

const meta = await import('./meta')
const { loadSkills } = await import('./index')
const { approvePendingSkill, listPendingSkills, proposeSkill, validateCard } = await import('./pending')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pending-'))
  meta.resetSkillMetaCache()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const base = { name: 'Deploy API', description: 'Deploys the API', content: 'steps' }

describe('create_skill card contract', () => {
  it('refuses a summary above 120 characters at proposal time', async () => {
    await expect(proposeSkill({ ...base, summary: 'x'.repeat(121), tags: ['a', 'b', 'c'] })).rejects.toThrow(/limit is 120/)
    expect(validateCard('x'.repeat(120), ['a', 'b', 'c'])).toBeNull()
    expect(validateCard('ok', ['a'])).toMatch(/at least/)
    expect(validateCard('two\nlines', ['a', 'b', 'c'])).toMatch(/single line/)
  })

  it('stages the card with the proposal and surfaces it on the card UI', async () => {
    await proposeSkill({ ...base, summary: 'Faz deploy da API', tags: ['deploy', 'api', 'rollback'], lang: 'Portuguese' })
    const [proposal] = await listPendingSkills()
    expect(proposal.summary).toBe('Faz deploy da API')
    expect(proposal.tags).toEqual(['deploy', 'api', 'rollback'])
    expect(proposal.files).toEqual([])
  })

  it('on approval the card is hashed against the file written at the destination', async () => {
    await proposeSkill({ ...base, summary: 'Faz deploy da API', tags: ['deploy', 'api', 'rollback'], lang: 'Portuguese' })
    expect(await approvePendingSkill('deploy_api')).toBe(true)
    const [skill] = await loadSkills()
    expect(skill.slug).toBe('deploy_api')
    expect(meta.cardState(skill)).toBe('valid')
    expect(meta.cardFor(skill)?.lang).toBe('Portuguese')
  })

  it('a bundle keeps its scripts and does not leak the staged card file', async () => {
    await proposeSkill({
      ...base,
      summary: 'Faz deploy da API',
      tags: ['deploy', 'api', 'rollback'],
      files: [{ path: 'scripts/run.sh', content: 'echo' }],
    })
    await approvePendingSkill('deploy_api')
    const [skill] = await loadSkills()
    expect(skill.scripts?.map((s) => path.basename(s))).toEqual(['run.sh'])
    expect(meta.cardState(skill)).toBe('valid')
  })
})
