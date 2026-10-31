import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '@shared/skills'
import { sanitizeSlug } from './parser'

let dir = ''
vi.mock('../storage', () => ({ dataDir: () => dir }))
vi.mock('../worktrees/main', () => ({
  folderInMainRepository: async (folder: string) => folder.replace(/\/\.worktrees\/[^/]+$/, ''),
}))

const meta = await import('./meta')

function skill(patch: Partial<Skill> = {}): Skill {
  return {
    name: 'Deploy API',
    description: 'Deploys the API',
    slug: 'deploy_api',
    content: 'steps',
    source: 'global',
    filePath: path.join(dir, 'deploy_api.skill'),
    ...patch,
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-meta-'))
  meta.resetSkillMetaCache()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('slug', () => {
  it('normalizes names: Deploy API → deploy_api, hyphen → underscore', () => {
    expect(sanitizeSlug('Deploy API')).toBe('deploy_api')
    expect(sanitizeSlug('deploy-api')).toBe('deploy_api')
  })
})

describe('card validity', () => {
  const card = { summary: 'Faz deploy', tags: ['deploy'], modelId: 'm', lang: 'Portuguese' }

  it('none → valid → stale when the content changes', async () => {
    const s = skill()
    expect(meta.cardState(s)).toBe('none')
    await meta.setCard(s, card)
    expect(meta.cardState(s)).toBe('valid')
    expect(meta.cardFor(s)?.summary).toBe('Faz deploy')
    expect(meta.cardState(skill({ content: 'other steps' }))).toBe('stale')
    expect(meta.cardFor(skill({ content: 'other steps' }))).toBeNull()
  })

  it('editing ONLY the purpose description invalidates the card', async () => {
    await meta.setCard(skill(), card)
    expect(meta.cardState(skill({ description: 'Deploys the API and the worker' }))).toBe('stale')
  })

  it('survives a restart (written to disk, atomically)', async () => {
    await meta.setCard(skill(), card)
    await meta.flushSkillMeta()
    meta.resetSkillMetaCache()
    expect(meta.cardState(skill())).toBe('valid')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('prunes by the disk: a missing file loses its card, a skill of another project keeps it', async () => {
    const other = skill({ slug: 'other', filePath: path.join(dir, 'other.skill') })
    fs.writeFileSync(other.filePath, 'x')
    await meta.setCard(skill(), card) // file never written
    await meta.setCard(other, card)
    expect(await meta.pruneOrphanCards()).toBe(1)
    expect(meta.cardState(other)).toBe('valid')
    expect(meta.cardState(skill())).toBe('none')
  })
})

describe('ledger', () => {
  it('counts once per conversation, never per click', async () => {
    expect(await meta.recordSkillUse({ slug: 'a', scope: 'chat', sessionId: 's1' })).toBe(true)
    expect(await meta.recordSkillUse({ slug: 'a', scope: 'chat', sessionId: 's1' })).toBe(false)
    expect(await meta.recordSkillUse({ slug: 'a', scope: 'chat', sessionId: 's2' })).toBe(true)
    expect(meta.metaViews([skill({ slug: 'a' })], 'chat')[0].conversations).toBe(2)
  })

  it('a turn with 3 workers is ONE conversation (the caller attributes to the parent)', async () => {
    for (let i = 0; i < 3; i++) await meta.recordSkillUse({ slug: 'a', scope: 'chat', sessionId: 'parent' })
    expect(meta.eventsForScope('chat')).toHaveLength(1)
  })

  it('scopes by the main repository and falls back to global for a project with no history', async () => {
    await meta.recordSkillUse({ slug: 'a', scope: '/repo', sessionId: 's1' })
    expect(meta.eventsForScope('/repo')).toHaveLength(1)
    expect(meta.eventsForScope('/brand-new')).toHaveLength(1)
    await meta.recordSkillUse({ slug: 'b', scope: '/brand-new', sessionId: 's2' })
    expect(meta.eventsForScope('/brand-new').map((e) => e.slug)).toEqual(['b'])
  })

  it('the panel marks usage that came from the global fallback', async () => {
    await meta.recordSkillUse({ slug: 'a', scope: '/repo2', sessionId: 's1' })
    expect(meta.metaViews([skill({ slug: 'a' })], '/repo2')[0].scopeGlobal).toBe(false)
    expect(meta.metaViews([skill({ slug: 'a' })], '/sem-historico')[0].scopeGlobal).toBe(true)
  })

  it('a worktree path resolves to the main repository', async () => {
    expect(await meta.usageScope('code', '/repo/.worktrees/feat')).toBe('/repo')
    expect(await meta.usageScope('chat', '/repo')).toBe('chat')
  })

  it('drops events older than 90 days and caps the size', async () => {
    const old = Date.now() - 100 * 86_400_000
    await meta.recordSkillUse({ slug: 'a', scope: 'chat', sessionId: 'old', at: old })
    await meta.recordSkillUse({ slug: 'a', scope: 'chat', sessionId: 'new' })
    expect(meta.eventsForScope('chat').map((e) => e.sessionId)).toEqual(['new'])
  })

  it('links a later open to the suggestion in the shadow log', async () => {
    await meta.logSkillSuggestion({ sessionId: 's1', message: 'x'.repeat(500), suggested: ['a', 'b'] })
    await meta.recordSkillUse({ slug: 'a', scope: 'chat', sessionId: 's1' })
    const [entry] = meta.shadowLog()
    expect(entry.opened).toEqual(['a'])
    expect(entry.message.length).toBeLessThanOrEqual(120)
  })
})

describe('preferences', () => {
  it('pin and never are per slug and can be undone', async () => {
    await meta.setPref('a', { pin: true })
    expect(meta.getPrefs().a.pin).toBeTypeOf('number')
    await meta.setPref('a', { never: true })
    await meta.setPref('a', { pin: false, never: false })
    expect(meta.getPrefs().a).toBeUndefined()
  })
})
