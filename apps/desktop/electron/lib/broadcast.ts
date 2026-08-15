import { BrowserWindow } from 'electron'
import type { ChatEvent } from '@shared/chat'
import type { RotinaEvent } from '@shared/rotinas'
import { forwardChatEvent, forwardRotinaEvent } from './companion-server'

/**
 * Emite um ChatEvent para todas as janelas + companions conectados.
 * Usado por módulos que não recebem o BrowserWindow (permission engine,
 * tool question) — o chat-engine continua usando seu emit(win) local
 * para os eventos de stream.
 */
export function broadcastChatEvent(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('chat:event', event)
  }
  // Forward to companion clients
  forwardChatEvent(event)
}

/**
 * Emite um RotinaEvent para todas as janelas + companions conectados —
 * é o que mantém o app mobile com as rotinas em sincronia (criar, editar,
 * excluir, execução começando/terminando).
 */
export function broadcastRotinaEvent(event: RotinaEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('rotinas:event', event)
  }
  forwardRotinaEvent(event)
}
