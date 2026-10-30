import { BrowserWindow } from 'electron'
import type { ChatEvent } from '@shared/chat'
import type { RoutineEvent } from '@shared/routines'
import type { PipelineEvent } from '@shared/pipeline'
import { forwardChatEvent, forwardPipelineEvent, forwardRoutineEvent } from './companion-server'

/**
 * Emits a ChatEvent to every window + connected companions. Used by modules that
 * do not receive the BrowserWindow (permission engine, tool question) — the
 * chat-engine keeps using its own local emit(win) for stream events.
 */
export function broadcastChatEvent(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('chat:event', event)
  }
  // Forward to companion clients
  forwardChatEvent(event)
}

/**
 * Emits a RoutineEvent to every window + connected companions — this is what
 * keeps the mobile app's routines in sync (create, edit, delete, execution
 * starting/finishing).
 */
export function broadcastRoutineEvent(event: RoutineEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('routines:event', event)
  }
  forwardRoutineEvent(event)
}

/**
 * Emits a PipelineEvent to every window + connected companions — it is the
 * engine's SINGLE funnel (engine.ts `emit`): the mobile app mirrors the whole
 * board through here (tasks, phases, queue, live progress).
 */
export function broadcastPipelineEvent(event: PipelineEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pipeline:event', event)
  }
  forwardPipelineEvent(event)
}
