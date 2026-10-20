import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS } from './index'

describe('skills nativas', () => {
  it('traz a skill web_recon como builtin', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.slug === 'web_recon')
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
    expect(skill?.name).toBeTruthy()
    expect(skill?.description).toBeTruthy()
  })

  it('a receita da web_recon traz guardrails e o uso das tools', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.slug === 'web_recon')
    const content = skill?.content ?? ''
    expect(content).toContain('robots.txt')
    expect(content).toContain('orbit.save')
    expect(content).toContain('run_browser_script')
  })

  it('nenhuma skill nativa fica sem slug', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.slug).toMatch(/^[a-z0-9_]+$/)
    }
  })
})
