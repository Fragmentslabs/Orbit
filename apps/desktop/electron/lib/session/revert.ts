import type { ChatMessage, SessionInfo, SessionRevert } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { broadcastChatEvent } from '../broadcast'
import { capture, diff, restore } from '../snapshot'
import { readJson, writeJson } from '../storage'

async function loadSession(sessionId: string): Promise<SessionInfo | null> {
  return readJson<SessionInfo>(StorageKeys.session(sessionId))
}

async function saveSession(session: SessionInfo): Promise<void> {
  const next = { ...session, updatedAt: Date.now() }
  await writeJson(StorageKeys.session(next.id), next)
  broadcastChatEvent({ type: 'session', sessionId: next.id, session: next })
}

export async function revert(sessionId: string, messageId: string): Promise<SessionRevert | null> {
  const session = await loadSession(sessionId)
  if (!session) return null

  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const target = messages.find((m) => m.id === messageId)
  if (!target) return null

  // Modo código: revert via git snapshot do filesystem
  if (session.directory && target.snapshot?.start) {
    const start = target.snapshot.start
    const current = await capture(session.directory)
    await restore(session.directory, start)
    const changes = await diff(session.directory, start, current)

    const revertState: SessionRevert = {
      messageId,
      snapshot: current,
      files: changes.files,
      diff: changes.patch,
    }
    await saveSession({ ...session, revert: revertState })
    return revertState
  }

  // Modo chat: apenas marca o ponto de revert (sem truncar mensagens).
  // O truncamento ocorre em cleanupRevert ao enviar nova mensagem,
  // consistente com o comportamento do modo código.
  const revertState: SessionRevert = { messageId }
  await saveSession({ ...session, revert: revertState })
  return revertState
}

export async function unrevert(sessionId: string): Promise<boolean> {
  const session = await loadSession(sessionId)
  if (!session?.revert) return false

  // Modo código: restore do filesystem
  if (session.directory && session.revert.snapshot) {
    await restore(session.directory, session.revert.snapshot)
    const next = { ...session }
    delete next.revert
    await saveSession(next)
    return true
  }

  // Modo chat: só remove o marcador de revert (mensagens nunca foram truncadas)
  const next = { ...session }
  delete next.revert
  await saveSession(next)
  return true
}

/**
 * Chamado ao enviar nova mensagem com revert ativo: descarta as mensagens a
 * partir do ponto de revert (o par user+assistant alvo) e limpa o estado.
 * O filesystem permanece no estado revertido (code) — a nova conversa segue dali.
 */
export async function cleanupRevert(sessionId: string): Promise<ChatMessage[] | null> {
  const session = await loadSession(sessionId)
  if (!session?.revert) return null

  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const idx = messages.findIndex((m) => m.id === session.revert!.messageId)
  let truncated = messages
  if (idx >= 0) {
    const cut = idx > 0 && messages[idx - 1].role === 'user' ? idx - 1 : idx
    truncated = messages.slice(0, cut)
    await writeJson(StorageKeys.messages(sessionId), truncated)
    broadcastChatEvent({ type: 'messages', sessionId, messages: truncated })
  }

  const next = { ...session }
  delete next.revert
  await saveSession(next)
  return truncated
}
