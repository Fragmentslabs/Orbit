import { describe, expect, it, vi } from 'vitest'
vi.mock('./memory/service', () => ({ loadPromptContext: async () => ({ core: [], seasonal: [], promotable: [], general: [], learning: [], project: [] }) }))
vi.mock('./skills', () => ({ loadSkills: async () => [] }))
vi.mock('./mcp', () => ({ listMcpToolDescriptions: () => [] }))
vi.mock('./past-chats', () => ({ buildPastChatsContext: async () => '', detectPastChatsIntent: () => false }))
vi.mock('./subchats', () => ({ listSubchats: async () => [], formatSubchatsBlock: () => '', conversationOriginBlock: async () => '' }))
vi.mock('./video/ffmpeg', () => ({ resolveFfmpeg: () => '/bin/ffmpeg' }))
vi.mock('./computer', () => ({ isComputerAvailable: () => false }))
vi.mock('./project-context', () => ({ projectContextBlock: async () => '' }))
vi.mock('./worktrees/main', () => ({ folderInMainRepository: async (d: string) => d }))
vi.mock('./app-settings', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@shared/app-settings')
  return { agentMayUseBrowser: () => true, agentMayControlComputer: () => false, getAppSettings: () => DEFAULT_APP_SETTINGS }
})
const { buildPromptSections } = await import('./prompts')

/**
 * The general chat's prompt is built from labelled sections; this keeps their weight in view.
 * Measured when the sections were introduced (tokens ≈ chars / 4, with the tool catalog on): chat
 * ~3.0k, code ~5.5k; the biggest chat parts are visuals (~1.2k) and documents (~0.8k). The
 * ceilings leave a little room — growing past them should be a decision, not an accident.
 */
const CEILING = { chat: 3500, code: 6200 }

async function weigh(mode: 'chat' | 'code') {
  const input = { sessionId: mode, text: 'oi', providerId: 'p', modelId: 'm', mode, directory: mode === 'code' ? '/p' : undefined, options: {} }
  const sections = await buildPromptSections(input as never, true, '- family: when to use')
  const byId = new Map<string, number>()
  for (const s of sections) byId.set(s.id, (byId.get(s.id) ?? 0) + s.text.length / 4)
  return { byId, total: [...byId.values()].reduce((a, b) => a + b, 0) }
}

describe('system prompt weight', () => {
  for (const mode of ['chat', 'code'] as const) {
    it(`${mode}: stays under its ceiling and every part is labelled`, async () => {
      const { byId, total } = await weigh(mode)
      expect(total).toBeLessThan(CEILING[mode])
      expect(byId.has('mode') && byId.size > 3).toBe(true)
      expect(byId.get('closing')).toBeGreaterThan(0)
    })
  }
})
