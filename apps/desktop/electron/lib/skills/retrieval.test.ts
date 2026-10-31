import { describe, expect, it } from 'vitest'
import type { Skill, SkillCard } from '@shared/skills'
import {
  flatten,
  renderSkillHints,
  searchSkills,
  skillIndexLine,
  skillSearchLine,
  type SkillEntry,
} from './retrieval'

function entry(slug: string, description: string, card?: Partial<SkillCard> & { tags: string[]; summary: string }): SkillEntry {
  const skill: Skill = { name: slug, description, slug, content: 'BODY', source: 'global', filePath: `/s/${slug}.skill` }
  return { skill, card: card ? ({ hash: 'h', at: '', modelId: 'm', lang: 'pt', ...card } as SkillCard) : null }
}

const video = entry('video_shorts', 'cuts videos', {
  summary: 'Corta vídeos longos em shorts verticais com legenda',
  tags: ['vídeo', 'shorts', 'legenda', 'ffmpeg', 'corte'],
})
const nfe = entry('nfe_validator', 'Validates Brazilian invoice XML against SEFAZ rules', {
  summary: 'Valida XML de nota fiscal contra as regras da SEFAZ',
  tags: ['nota fiscal', 'XML', 'SEFAZ', 'NFe', 'validar'],
})
const plain = entry('deploy_api', 'Deploys the API to staging and production, with rollback and health checks')

describe('flatten / index line', () => {
  it('cuts at a word boundary and keeps one line', () => {
    const long = 'palavra '.repeat(40)
    const out = flatten(`${long}\nmais`, 120)
    expect(out.length).toBeLessThanOrEqual(121)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/\n/)
    expect(out).not.toMatch(/palav…$/)
  })

  it('a skill without a card uses the truncated description; without anything, only the slug', () => {
    const long = entry('x', 'a '.repeat(200))
    expect(skillIndexLine(long).length).toBeLessThanOrEqual(135)
    expect(skillIndexLine(entry('bare', ''))).toBe('- @bare')
    expect(skillIndexLine(video)).toBe('- @video_shorts — Corta vídeos longos em shorts verticais com legenda')
  })
})

describe('searchSkills', () => {
  const entries = [video, nfe, plain]

  it('"crie um vídeo para mim" matches the tag vídeo; an unrelated question matches nothing', async () => {
    const hit = await searchSkills({ query: 'crie um vídeo para mim', entries, mode: 'suggest' })
    expect(hit.map((h) => h.entry.skill.slug)).toEqual(['video_shorts'])
    expect(await searchSkills({ query: 'qual a capital da França', entries, mode: 'suggest' })).toEqual([])
  })

  it('is stricter without a card: one loose word does not suggest', async () => {
    const one = await searchSkills({ query: 'preciso fazer o deploy', entries, mode: 'suggest' })
    expect(one).toEqual([])
    const two = await searchSkills({ query: 'faz o deploy da api em staging', entries, mode: 'suggest' })
    expect(two.map((h) => h.entry.skill.slug)).toEqual(['deploy_api'])
  })

  it('the explicit search is looser than the spontaneous one', async () => {
    const q = 'rollback'
    expect(await searchSkills({ query: q, entries, mode: 'suggest' })).toEqual([])
    const loose = await searchSkills({ query: q, entries, mode: 'loose' })
    expect(loose.map((h) => h.entry.skill.slug)).toEqual(['deploy_api'])
  })

  it('finds by the tag phrase and the plural', async () => {
    const hit = await searchSkills({ query: 'valida essas notas fiscais', entries, mode: 'suggest' })
    expect(hit[0]?.entry.skill.slug).toBe('nfe_validator')
    const plural = await searchSkills({ query: 'gera uns vídeos pra mim', entries, mode: 'suggest' })
    expect(plural[0]?.entry.skill.slug).toBe('video_shorts')
  })

  it('takes the semantic side when the caller provides it', async () => {
    const vecs = new Map<string, Float32Array>()
    const semantic = {
      queryVec: new Float32Array([1, 0]),
      embedDocs: async (texts: string[]) =>
        texts.map((t) => (t.includes('nota fiscal') ? new Float32Array([0.9, 0.1]) : new Float32Array([0, 1]))),
    }
    void vecs
    const hit = await searchSkills({ query: 'emitir imposto', entries, mode: 'suggest', semantic })
    expect(hit.map((h) => h.entry.skill.slug)).toEqual(['nfe_validator'])
  })
})

describe('rendering', () => {
  it('labels the hints as automatic and unverified, and says the content is not loaded', async () => {
    const hits = await searchSkills({ query: 'crie um vídeo', entries: [video], mode: 'suggest' })
    const text = renderSkillHints(hits)
    expect(text).toContain('[skill hints — automatic and unverified]')
    expect(text).toContain('NOT loaded')
    expect(text).toContain('@video_shorts')
    expect(text).not.toContain('BODY')
    expect(renderSkillHints([])).toBe('')
  })

  it('skill_search lines carry the tags', () => {
    expect(skillSearchLine(video)).toBe(
      '@video_shorts — Corta vídeos longos em shorts verticais com legenda [vídeo, shorts, legenda, ffmpeg, corte]',
    )
  })
})
