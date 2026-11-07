import fsp from 'node:fs/promises'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { readJson } from '../storage'
import { designPiecesDir } from '../tools/design'
import { motionPiecesDir } from '../tools/motion'

/** What a craft chat is told about its artifact at every turn (user message, never the system prompt). */

/**
 * A chat made for an artifact that already exists (from its card) is told which one. Motion
 * and design pieces live in the folder of the chat that made them, so the id is how another
 * chat reaches the same piece.
 */
async function focusLine(kind: 'motion' | 'design', sessionId: string): Promise<string> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  const id = session?.artifact?.kind === kind ? session.artifact.id : undefined
  return id
    ? `Artifact in focus: id ${id}. It was made in another conversation: pass this id as \`id\` to the ${kind} tools to read and change it.`
    : ''
}

async function namesIn(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'renders').map((e) => e.name)
}

export async function motionTurnBlock(sessionId: string): Promise<string> {
  const names = await namesIn(motionPiecesDir(sessionId))
  const focus = await focusLine('motion', sessionId)
  return [
    '<motion-context>',
    ...(focus ? [focus] : []),
    names.length
      ? `Compositions in this conversation: ${names.join(', ')}. Read one with motion_read before changing it.`
      : 'No composition exists in this conversation yet. Create one with motion_write.',
    '</motion-context>',
  ].join('\n')
}

export async function designTurnBlock(sessionId: string): Promise<string> {
  const names = await namesIn(designPiecesDir(sessionId))
  const focus = await focusLine('design', sessionId)
  return [
    '<design-context>',
    ...(focus ? [focus] : []),
    names.length
      ? `Canvases in this conversation: ${names.join(', ')}. Read one with design_read before changing it.`
      : 'No canvas exists in this conversation yet. Create one with design_write.',
    '</design-context>',
  ].join('\n')
}
