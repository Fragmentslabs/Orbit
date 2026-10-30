import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS } from './index'

describe('skills nativas', () => {
  it('brings the web_recon skill as builtin', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.slug === 'web_recon')
    expect(skill).toBeDefined()
    expect(skill?.source).toBe('builtin')
    expect(skill?.name).toBeTruthy()
    expect(skill?.description).toBeTruthy()
  })

  it('the web_recon recipe brings guardrails and the use of the tools', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.slug === 'web_recon')
    const content = skill?.content ?? ''
    expect(content).toContain('robots.txt')
    expect(content).toContain('orbit.save')
    expect(content).toContain('run_browser_script')
  })

  it('brings the media_compress skill pointing at the tool, not at bare ffmpeg', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.slug === 'media_compress')
    expect(skill?.source).toBe('builtin')
    const content = skill?.content ?? ''
    // The deterministic path is the tool; manual ffmpeg is plan B.
    expect(content).toContain('media_compress')
    expect(content.indexOf('media_compress')).toBeLessThan(content.indexOf('```bash'))
    // The pitfalls the text has to carry so the agent does not rediscover them.
    expect(content).toContain('ffprobe')
    expect(content).toContain('image_edit')
  })

  it('no built-in skill is left without a slug', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.slug).toMatch(/^[a-z0-9_]+$/)
    }
  })
})
