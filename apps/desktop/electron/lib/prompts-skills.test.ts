import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendMessageInput } from '@shared/chat'
import type { Skill } from '@shared/skills'

/**
 * The skills block of the system prompt: an index, never a user skill's body.
 */

const skills: Skill[] = []
const cards = new Map<string, { summary: string }>()

vi.mock('./skills', () => ({ loadSkills: async () => skills }))
vi.mock('./skills/meta', () => ({
  cardFor: (s: Skill) => cards.get(s.slug) ?? null,
  eventsForScope: () => [],
  getPrefs: () => ({}),
  skillHash: (s: Skill) => `${s.slug}:${s.content}:${s.description}`,
  usageScope: async () => 'chat',
}))
vi.mock('./memory/service', () => ({ loadPromptContext: async () => ({ core: [], seasonal: [], promotable: [], general: [], learning: [], project: [] }) }))
vi.mock('./mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('./past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
vi.mock('./subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '', conversationOriginBlock: async () => '' }))
vi.mock('./app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return { agentMayUseBrowser: () => false, agentMayControlComputer: () => false, getAppSettings: () => DEFAULT_APP_SETTINGS }
})

const { buildSystemPrompt, ensureSkillsBlock, promptSkillSlugs, skillDeltaTurnBlock } = await import('./prompts')
const { snapshotOf } = await import('./skills/mention')

function make(slug: string, source: Skill['source'], description = `does ${slug}`): Skill {
  return { name: slug, slug, description, content: `SECRET BODY OF ${slug}`, source, filePath: `/skills/${slug}.skill` }
}

function turn(sessionId: string): SendMessageInput {
  return {
    sessionId,
    text: 'oi',
    providerId: 'p',
    modelId: 'm',
    mode: 'chat',
    options: {},
  } as SendMessageInput
}

beforeEach(() => {
  skills.length = 0
  cards.clear()
  skills.push(make('web_recon', 'builtin', 'Map and extract a website'), make('media_compress', 'builtin', 'Compress video'))
})

describe('skills block of the system prompt', () => {
  it('carries the two native skills with their description and never a body', async () => {
    skills.push(make('deploy_api', 'global'))
    const prompt = await buildSystemPrompt(turn('k1'))
    expect(prompt).toContain('- @web_recon — Map and extract a website (call skill_read to apply it)')
    expect(prompt).toContain('- @media_compress — Compress video (call skill_read to apply it)')
    expect(prompt).toContain('- @deploy_api — does deploy_api')
    expect(prompt).not.toContain('SECRET BODY')
  })

  it('with 30 skills: 25 described, 5 by name only, none missing', async () => {
    for (let i = 0; i < 30; i++) skills.push(make(`skill_${String(i).padStart(2, '0')}`, 'global'))
    const prompt = await buildSystemPrompt(turn('k2'))
    const described = prompt.match(/^- @skill_\d\d/gm) ?? []
    expect(described).toHaveLength(25)
    const tail = prompt.slice(prompt.indexOf('Also available'))
    for (const slug of ['skill_25', 'skill_26', 'skill_27', 'skill_28', 'skill_29']) expect(tail).toContain(`@${slug}`)
    expect(tail).not.toMatch(/skill_0\d/)
    expect(prompt).not.toMatch(/there are \d+ more/i)
  })

  it('has no second layer when everything fits', async () => {
    skills.push(make('only_one', 'global'))
    expect(await buildSystemPrompt(turn('k3'))).not.toContain('Also available')
  })

  it('uses the card summary when valid, else the description cut at 120 on one line', async () => {
    skills.push(make('carded', 'global', 'long long description'), make('plain', 'global', `${'palavra '.repeat(40)}\nfim`))
    cards.set('carded', { summary: 'Resumo do cartão' })
    const prompt = await buildSystemPrompt(turn('k4'))
    expect(prompt).toContain('- @carded — Resumo do cartão')
    const plain = prompt.split('\n').find((l) => l.startsWith('- @plain'))!
    expect(plain.length).toBeLessThanOrEqual('- @plain — '.length + 121)
    expect(plain.endsWith('…')).toBe(true)
  })

  it('is frozen for the session; the change arrives as a delta note, once', async () => {
    skills.push(make('first', 'global'))
    const frozen = await buildSystemPrompt(turn('k5'))
    skills.push(make('created_midway', 'global'))
    expect(await buildSystemPrompt(turn('k5'))).toBe(frozen)
    expect(frozen).not.toContain('created_midway')

    const note = skillDeltaTurnBlock('k5', 'chat', undefined, snapshotOf(skills, (s) => `${s.slug}:${s.content}:${s.description}`))
    expect(note).toContain('[skills changed after this prompt was built]')
    expect(note).toContain('@created_midway')
    // Nothing is told twice.
    expect(skillDeltaTurnBlock('k5', 'chat', undefined, snapshotOf(skills, (s) => `${s.slug}:${s.content}:${s.description}`))).toBe('')
  })

  it('exposes level 1 so the turn hints do not repeat it', async () => {
    skills.push(make('listed', 'global'))
    await ensureSkillsBlock(turn('k6'))
    expect(promptSkillSlugs('k6', 'chat')).toEqual(['listed'])
  })
})
