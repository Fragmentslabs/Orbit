import { tool } from 'ai'
import { z } from 'zod'
import type { PanelSnapshotTab } from '@shared/panel'
import { panelSnapshotFor } from '../panel-state'

/**
 * What the user is seeing in the side tab, for the agent.
 *
 * It is not an attachment nor a screen capture: the renderer mirrors the panel store to
 * main (see panel-store.ts) and this tool returns the latest snapshot OF THE SESSION that
 * is calling. It serves for "this", "here", "that design that is open" —
 * the agent finds out what is on the screen without the user having to attach it again.
 */

function describeTab(tab: PanelSnapshotTab): string {
  const ids: string[] = []
  if (tab.artifactId) ids.push(`artifact id ${tab.artifactId}`)
  if (tab.motionId) ids.push(`motion id ${tab.motionId}${tab.motionPath ? `, path ${tab.motionPath}` : ''}`)
  if (tab.designId) ids.push(`design id ${tab.designId}${tab.designPath ? `, path ${tab.designPath}` : ''}`)
  if (tab.documentId) ids.push(`document id ${tab.documentId}`)
  if (tab.memoryId) ids.push(`memory id ${tab.memoryId}`)
  if (tab.url) ids.push(`url ${tab.url}`)
  return `${tab.type} "${tab.title}"${ids.length ? ` (${ids.join('; ')})` : ''}`
}

export function createPanelTools(sessionId: string) {
  return {
    read_open_panel: tool({
      description:
        'Returns what the user currently has open in the right side panel of this conversation: the active tab and every open tab, with the ids needed to act on them. ' +
        'Use it when the user says "this one", "here", "the one I have open", or otherwise refers to something on screen without attaching it — then read/edit it with the matching tool (read_artifact/edit_artifact, motion_read/motion_edit, design_read/design_edit). Read-only and needs no permission.',
      inputSchema: z.object({}),
      execute: async () => {
        const snap = panelSnapshotFor(sessionId)
        if (!snap) {
          return 'The right panel has no recorded state for this conversation yet (nothing was opened since the app started).'
        }
        if (snap.tabs.length === 0) {
          return 'The right panel has no tabs open in this conversation.'
        }
        const active = snap.tabs.find((t) => t.id === snap.activeTabId)
        return [
          active ? `Active tab: ${describeTab(active)}.` : 'No tab is active (the panel may be closed).',
          'Open tabs:',
          ...snap.tabs.map((t) => `- ${describeTab(t)}${t.id === snap.activeTabId ? ' [active]' : ''}`),
        ].join('\n')
      },
    }),
  }
}
