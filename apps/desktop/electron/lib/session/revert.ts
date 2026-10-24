import type { ChatMessage, SessionInfo, SessionRevert } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { broadcastChatEvent } from '../broadcast'
import { capture, diff, restore } from '../snapshot'
import { readJson, writeJson } from '../storage'
import { discardMediaRevert, revertMedia, unrevertMedia } from './media-revert'

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
  const revertState: SessionRevert = session.directory
    ? await revertFiles(session.directory, messageId, discarded, start)
    : // Modo chat: a conversa não tem pasta de trabalho
      { messageId, discardedMessages: discarded }

  // Mídia (peças e galeria): nos DOIS modos — mora no armazenamento do app, que
  // o snapshot da pasta de trabalho não alcança. Desfaz o que os turnos
  // descartados produziram, do primeiro ao último.
  const media = await revertMedia(sessionId, assistantIdsOf(discarded))
  if (media) revertState.media = media

  await saveSession({ ...session, revert: revertState })
  return revertState
}

function assistantIdsOf(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === 'assistant').map((m) => m.id)
}

/**
 * Modo código: restaura a pasta de trabalho para o snapshot do início do turno.
 * O truncamento já foi persistido por quem chama — se a restauração falhar, a
 * exceção NÃO pode subir: as mensagens ficariam cortadas sem barra de revert
 * nem unrevert. Devolve filesRestored:false com o motivo para a UI avisar.
 */
async function revertFiles(
  directory: string,
  messageId: string,
  discarded: ChatMessage[],
  start: string | undefined,
): Promise<SessionRevert> {
  if (!start) {
    // Sem snapshot para esta mensagem: não há como restaurar o filesystem. Em
    // vez do fallback silencioso para "modo chat", sinaliza explicitamente que
    // os arquivos não puderam ser desfeitos.
    return { messageId, filesRestored: false, reason: 'no-snapshot', discardedMessages: discarded }
  }
  try {
    const current = await capture(directory)
    await restore(directory, start)
    const changes = await diff(directory, start, current)
    return {
      messageId,
      snapshot: current,
      files: changes.files,
      diff: changes.patch,
      filesRestored: true,
      discardedMessages: discarded,
    }
  } catch (err) {
    console.error('[revert] falha ao restaurar o filesystem (truncamento já salvo):', err)
    return { messageId, filesRestored: false, reason: 'capture-failed', discardedMessages: discarded }
  }
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
  // Mídia: o redo guardado pelo revert (nos dois modos)
  await unrevertMedia(sessionId)

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
  // Os turnos descartados não voltam mais: os diários de mídia deles e o redo
  // deixam de servir.
  await discardMediaRevert(sessionId, assistantIdsOf(session.revert.discardedMessages ?? []))

  const next = { ...session }
  delete next.revert
  await saveSession(next)
  return truncated
}
