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

/**
 * Trunca a lista a partir do turno que contém `messageId`, retornando
 * [truncated, discarded].
 *
 * O revert é acionado pela mensagem do USUÁRIO: corta nela mesma, descartando
 * ela e tudo que veio depois. Um id de mensagem de assistente continua aceito
 * (companion em versão antiga) e corta no par user+resposta — mas só quando a
 * anterior é mesmo do usuário, senão duas mensagens de usuário seguidas (envio
 * que falhou, fila) fariam o corte engolir o turno anterior.
 */
function truncateAt(messages: ChatMessage[], messageId: string): [ChatMessage[], ChatMessage[]] {
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx < 0) return [messages, []]
  const cut =
    messages[idx].role === 'assistant' && idx > 0 && messages[idx - 1].role === 'user'
      ? idx - 1
      : idx
  return [messages.slice(0, cut), messages.slice(cut)]
}

/**
 * Tree hash a restaurar no modo código: o estado do filesystem ANTES do turno.
 *
 * Só mensagens de assistente carregam snapshot (é o chat-engine que captura no
 * início do stream). Como o revert agora parte da mensagem do usuário, o
 * snapshot vem da resposta imediatamente seguinte. Olhamos só o alvo e o
 * próximo de propósito — varrer o resto da lista acharia o snapshot de um turno
 * posterior e restauraria o filesystem para o estado errado.
 */
function startSnapshotFor(messages: ChatMessage[], idx: number): string | undefined {
  const own = messages[idx]?.snapshot?.start
  if (own) return own
  const next = messages[idx + 1]
  return next?.role === 'assistant' ? next.snapshot?.start : undefined
}

export async function revert(sessionId: string, messageId: string): Promise<SessionRevert | null> {
  const session = await loadSession(sessionId)
  if (!session) return null

  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const targetIdx = messages.findIndex((m) => m.id === messageId)
  if (targetIdx < 0) return null

  // Ambos os modos truncam as mensagens imediatamente
  const [truncated, discarded] = truncateAt(messages, messageId)
  if (discarded.length === 0) return null

  await writeJson(StorageKeys.messages(sessionId), truncated)
  broadcastChatEvent({ type: 'messages', sessionId, messages: truncated })

  const start = startSnapshotFor(messages, targetIdx)
  if (session.directory && start) {
    // Modo código: também restaura o filesystem para o snapshot da mensagem
    const current = await capture(session.directory)
    await restore(session.directory, start)
    const changes = await diff(session.directory, start, current)

    const revertState: SessionRevert = {
      messageId,
      snapshot: current,
      files: changes.files,
      diff: changes.patch,
      discardedMessages: discarded,
    }
    await saveSession({ ...session, revert: revertState })
    return revertState
  }

  // Modo chat: apenas truncamento
  const revertState: SessionRevert = { messageId, discardedMessages: discarded }
  await saveSession({ ...session, revert: revertState })
  return revertState
}

export async function unrevert(sessionId: string): Promise<boolean> {
  const session = await loadSession(sessionId)
  if (!session?.revert) return false

  // Restaura mensagens descartadas (ambos os modos)
  if (session.revert.discardedMessages) {
    const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
    const restored = [...messages, ...session.revert.discardedMessages]
    await writeJson(StorageKeys.messages(sessionId), restored)
    broadcastChatEvent({ type: 'messages', sessionId, messages: restored })
  }

  // Modo código: também restaura o filesystem
  if (session.directory && session.revert.snapshot) {
    await restore(session.directory, session.revert.snapshot)
  }

  const next = { ...session }
  delete next.revert
  await saveSession(next)
  return true
}

/**
 * Chamado ao enviar nova mensagem com revert ativo: se as mensagens ainda
 * não foram truncadas (ex: revert foi salvo mas algo falhou), trunca agora.
 * Remove o estado de revert da sessão.
 */
export async function cleanupRevert(sessionId: string): Promise<ChatMessage[] | null> {
  const session = await loadSession(sessionId)
  if (!session?.revert) return null

  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const [truncated] = truncateAt(messages, session.revert.messageId)
  if (truncated.length < messages.length) {
    await writeJson(StorageKeys.messages(sessionId), truncated)
    broadcastChatEvent({ type: 'messages', sessionId, messages: truncated })
  }

  const next = { ...session }
  delete next.revert
  await saveSession(next)
  return truncated
}
