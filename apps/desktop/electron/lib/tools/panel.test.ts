import { describe, expect, it, vi } from 'vitest'
import type { PanelSnapshot } from '@shared/panel'

vi.mock('electron', () => ({
  ipcMain: { on: () => {} },
}))

const { createPanelTools } = await import('./panel')
const { setPanelSnapshot } = await import('../panel-state')

type Exec = (input: unknown, options: unknown) => Promise<string>
const run = (tools: Record<string, unknown>, input: unknown) =>
  (tools.read_open_panel as { execute: Exec }).execute(input, { toolCallId: 'c', messages: [], abortSignal: undefined })

const snapshot = (sessionId: string, over: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  sessionId,
  activeTabId: null,
  tabs: [],
  updatedAt: Date.now(),
  ...over,
})

describe('read_open_panel', () => {
  it('says there is no state when the renderer never reported', async () => {
    const out = await run(createPanelTools('never-seen'), {})
    expect(out).toMatch(/no recorded state/i)
  })

  it('reports the active tab with the ids needed to act on it', async () => {
    setPanelSnapshot(
      snapshot('sess-panel', {
        activeTabId: 'design-1',
        tabs: [
          { id: 'artifact-1', type: 'artifact', title: 'Invoice', artifactId: 'art_abc.html' },
          { id: 'design-1', type: 'design', title: 'Landing page', designId: 'dsg_123', designPath: '/tmp/landing' },
        ],
      }),
    )
    const out = await run(createPanelTools('sess-panel'), {})
    expect(out).toContain('Active tab: design "Landing page"')
    expect(out).toContain('design id dsg_123')
    expect(out).toContain('/tmp/landing')
    expect(out).toContain('artifact id art_abc.html')
    expect(out).toContain('[active]')
  })

  it('is scoped to the calling session', async () => {
    setPanelSnapshot(
      snapshot('sess-a', { activeTabId: 'a', tabs: [{ id: 'a', type: 'motion', title: 'Intro', motionId: 'mv_a' }] }),
    )
    const out = await run(createPanelTools('sess-b'), {})
    expect(out).toMatch(/no recorded state|no tabs open/i)
  })

  it('handles an open panel with no tabs', async () => {
    setPanelSnapshot(snapshot('sess-empty', { tabs: [] }))
    const out = await run(createPanelTools('sess-empty'), {})
    expect(out).toMatch(/no tabs open/i)
  })
})
