import { describe, expect, it, vi } from 'vitest'
import type { Skill } from '@shared/skills'

vi.mock('../app-settings', () => ({ getAppSettings: () => ({ auxModel: null }) }))
vi.mock('../aux-model', () => ({ resolveAuxModel: vi.fn() }))
vi.mock('../storage', () => ({ dataDir: () => '/nonexistent' }))
vi.mock('../worktrees/main', () => ({ folderInMainRepository: async (f: string) => f }))
vi.mock('ai', () => ({ generateText: vi.fn() }))

const { optimizeSkill, NoAuxModelError } = await import('./optimize')

describe('optimizeSkill', () => {
  it('throws NoAuxModelError without an auxiliary model, spending nothing', async () => {
    const skill: Skill = { name: 'x', slug: 'x', description: '', content: '', source: 'global', filePath: '/x' }
    await expect(optimizeSkill(skill, { language: 'Portuguese' })).rejects.toBeInstanceOf(NoAuxModelError)
  })
})
