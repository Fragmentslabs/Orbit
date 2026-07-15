import type { ChatMessage, SessionInfo, SessionRevert } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { broadcastChatEvent } from '../broadcast'
import { capture, diff, restore } from '../snapshot'
import { readJson, writeJson } from '../storage'

/**
 * Revert per-message (modo código): restaura o filesystem para o snapshot
 * `start` de uma resposta do assistente. O estado atual é capturado antes
 * (revert.snapshot) para permitir desfazer; ao enviar nova mensagem com um
 * revert ativo, as mensagens posteriores ao ponto são removidas (cleanup).
 */

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
  if (!session?.directory) return null

  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const target = messages.find((m) => m.id === messageId)
  const start = target?.snapshot?.start
  if (!start) return null

  // Estado atual vira o snapshot de unrevert; o diff lista o que foi desfeito
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

export async function unrevert(sessionId: string): Promise<boolean> {
  const session = await loadSession(sessionId)
  if (!session?.directory || !session.revert?.snapshot) return false

  await restore(session.directory, session.revert.snapshot)
  const next = { ...session }
  delete next.revert
  await saveSession(next)
  return true
}

/**
 * Chamado ao enviar nova mensagem com revert ativo: descarta as mensagens a
 * partir do ponto de revert (o par user+assistant alvo) e limpa o estado.
 * O filesystem permanece no estado revertido — a nova conversa segue dali.
 */
export async function cleanupRevert(sessionId: string): Promise<ChatMessage[] | null> {
  const session = await loadSession(sessionId)
  if (!session?.revert) return null

  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const idx = messages.findIndex((m) => m.id === session.revert!.messageId)
  let truncated = messages
  if (idx >= 0) {
    // Inclui a mensagem do usuário imediatamente anterior (par da resposta)
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
