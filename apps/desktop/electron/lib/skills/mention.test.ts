import { describe, expect, it } from 'vitest'
import type { Skill } from '@shared/skills'
import { diffSnapshots, mentionedSlugs, renderSkillDelta, skillBody } from './mention'

describe('mentionedSlugs', () => {
  const slugs = ['deploy', 'deploy_api', 'video_shorts']

  it('respects the boundary: @deploy does not match inside @deploy_api', () => {
    expect(mentionedSlugs('usa o @deploy_api agora', slugs)).toEqual(['deploy_api'])
    expect(mentionedSlugs('usa o @deploy e o @deploy_api', slugs)).toEqual(['deploy', 'deploy_api'])
  })

  it('ignores e-mails, unknown slugs, repeats, and is case-insensitive', () => {
    expect(mentionedSlugs('manda para me@deploy.com', slugs)).toEqual([])
    expect(mentionedSlugs('@nada @Video_Shorts @video_shorts', slugs)).toEqual(['video_shorts'])
    expect(mentionedSlugs('(@deploy), certo?', slugs)).toEqual(['deploy'])
  })

  it('a hyphen is not part of a slug, and does not fall back to a shorter slug', () => {
    expect(mentionedSlugs('@deploy-api', slugs)).toEqual([])
    expect(mentionedSlugs('@deploy-api não casa, mas @deploy_api sim', slugs)).toEqual(['deploy_api'])
  })
})

describe('skillBody / delta', () => {
  const skill: Skill = {
    name: 'X', description: 'does x', slug: 'x', content: 'STEPS', source: 'global', filePath: '/x', scripts: ['/x/run.sh'],
  }

  it('brings the body and the helper files', () => {
    const body = skillBody(skill)
    expect(body).toContain('STEPS')
    expect(body).toContain('- /x/run.sh')
  })

  it('diffs added, removed and edited; says nothing when nothing changed', () => {
    const delta = diffSnapshots({ a: '1', b: '1', c: '1' }, { a: '1', b: '2', d: '1' })
    expect(delta).toEqual({ added: ['d'], removed: ['c'], changed: ['b'] })
    const text = renderSkillDelta(delta)
    expect(text).toContain('now available (call skill_read to apply): @d')
    expect(text).toContain('no longer available: @c')
    expect(text).toContain('@b')
    expect(renderSkillDelta({ added: [], removed: [], changed: [] })).toBe('')
  })
})
