import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { panelContextLine, panelSnapshotFor, setPanelSnapshot } = await import('./panel-state')

const tab = (over: Record<string, unknown>) => ({ id: 't', type: 'design', title: 'Landing', ...over }) as never

describe('what is open on screen, for any chat', () => {
  beforeEach(() => {
    // A blank slate: an empty snapshot of each key used below.
    for (const key of ['s1', 's2', '__orphan__']) setPanelSnapshot({ sessionId: key, activeTabId: null, tabs: [], updatedAt: 0 })
  })

  it('has nothing to say while nothing relevant is open', () => {
    expect(panelContextLine('s1')).toBeNull()
    setPanelSnapshot({ sessionId: 's1', activeTabId: 'c', tabs: [tab({ id: 'c', type: 'chat', title: 'Sub chat' })], updatedAt: 1 })
    expect(panelContextLine('s1')).toBeNull()
  })

  it('names the tab in front and the others, with the ids the tools need', () => {
    setPanelSnapshot({
      sessionId: 's1',
      activeTabId: 'a',
      tabs: [tab({ id: 'a', designId: 'dsg_1', title: 'Landing' }), tab({ id: 'b', type: 'document', documentId: 'doc1', title: 'Plano' })],
      updatedAt: 1,
    })
    const line = panelContextLine('s1')!
    expect(line).toContain('in front: design "Landing" (design id dsg_1)')
    expect(line).toContain('also open: document "Plano" (document id doc1)')
    expect(line).toContain('not instructions')
  })

  it('lends the draft panel on screen to a chat that was just born, and only that', () => {
    setPanelSnapshot({ sessionId: '__orphan__', activeTabId: 'a', tabs: [tab({ id: 'a', designId: 'dsg_9' })], updatedAt: 1, onScreen: true })
    expect(panelSnapshotFor('s2')?.tabs[0].designId).toBe('dsg_9')
    // The chat's own panel wins as soon as it has tabs.
    setPanelSnapshot({ sessionId: 's2', activeTabId: 'x', tabs: [tab({ id: 'x', designId: 'dsg_2' })], updatedAt: 2 })
    expect(panelSnapshotFor('s2')?.tabs[0].designId).toBe('dsg_2')
    // A draft panel that is not on screen is nobody's context.
    setPanelSnapshot({ sessionId: 's2', activeTabId: null, tabs: [], updatedAt: 3 })
    setPanelSnapshot({ sessionId: '__orphan__', activeTabId: 'a', tabs: [tab({ id: 'a', designId: 'dsg_9' })], updatedAt: 4, onScreen: false })
    expect(panelSnapshotFor('s2')?.tabs).toEqual([])
  })

  it('moves the on-screen mark from one panel to the other', () => {
    setPanelSnapshot({ sessionId: '__orphan__', activeTabId: 'a', tabs: [tab({ id: 'a' })], updatedAt: 1, onScreen: true })
    setPanelSnapshot({ sessionId: 's1', activeTabId: 'b', tabs: [tab({ id: 'b' })], updatedAt: 2, onScreen: true })
    expect(panelSnapshotFor('s2')?.tabs).toEqual([])
  })
})
