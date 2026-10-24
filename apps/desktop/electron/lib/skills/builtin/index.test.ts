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

  it('traz a skill media_compress apontando para a tool, não para o ffmpeg solto', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.slug === 'media_compress')
    expect(skill?.source).toBe('builtin')
    const content = skill?.content ?? ''
    // O caminho determinístico é a tool; o ffmpeg manual é o plano B.
    expect(content).toContain('media_compress')
    expect(content.indexOf('media_compress')).toBeLessThan(content.indexOf('```bash'))
    // As armadilhas que o texto precisa carregar para o agente não redescobrir.
    expect(content).toContain('ffprobe')
    expect(content).toContain('image_edit')
  })

  it('nenhuma skill nativa fica sem slug', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.slug).toMatch(/^[a-z0-9_]+$/)
    }
  })
})
