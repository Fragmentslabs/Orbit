import type { ChatMessage, SessionInfo, SessionRevert, UnrevertResult } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { broadcastChatEvent } from '../broadcast'
import { capture, diffPaths, transition } from '../snapshot'
import { readJson, writeJson } from '../storage'
import { discardMediaRevert, revertMedia, unrevertMedia } from './media-revert'
import { withWorkspaceLock } from './workspace-lock'

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
 * A mensagem de assistente dona do snapshot do turno.
 *
 * Só mensagens de assistente carregam snapshot (é o chat-engine que captura no
 * início do stream). Como o revert agora parte da mensagem do usuário, o
 * snapshot vem da resposta imediatamente seguinte. Olhamos só o alvo e o
 * próximo de propósito — varrer o resto da lista acharia o snapshot de um turno
 * posterior e restauraria o filesystem para o estado errado.
 */
function assistantFor(messages: ChatMessage[], idx: number): ChatMessage | undefined {
  const own = messages[idx]
  if (own?.role === 'assistant') return own
  const next = messages[idx + 1]
  return next?.role === 'assistant' ? next : undefined
}

export async function revert(sessionId: string, messageId: string): Promise<SessionRevert | null> {
  const session = await loadSession(sessionId)
  if (!session) return null

  // A pasta é o workspace: a trava impede que um turno de OUTRA conversa na
  // mesma pasta escreva entre a leitura das mensagens e a transição S/E/C.
  // Sem pasta (modo chat), só há mensagens e mídia.
  const work = async (): Promise<SessionRevert | null> => {
    const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
    const targetIdx = messages.findIndex((m) => m.id === messageId)
    if (targetIdx < 0) return null

    // Ambos os modos truncam as mensagens imediatamente
    const [truncated, discarded] = truncateAt(messages, messageId)
    if (discarded.length === 0) return null

    await writeJson(StorageKeys.messages(sessionId), truncated)
    broadcastChatEvent({ type: 'messages', sessionId, messages: truncated })

    const assistant = assistantFor(messages, targetIdx)
    const snapshot = assistant?.snapshot
    const revertState: SessionRevert = session.directory
      ? await revertFiles(session.directory, messageId, discarded, snapshot)
      : // Modo chat: a conversa não tem pasta de trabalho
        { messageId, discardedMessages: discarded }

    // Mídia (peças e galeria): nos DOIS modos — mora no armazenamento do app,
    // que o snapshot da pasta de trabalho não alcança. Desfaz o que os turnos
    // descartados produziram, do primeiro ao último.
    const media = await revertMedia(sessionId, assistantIdsOf(discarded))
    if (media) revertState.media = media

    await saveSession({ ...session, revert: revertState })
    return revertState
  }

  return session.directory ? withWorkspaceLock(session.directory, work) : work()
}

function assistantIdsOf(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === 'assistant').map((m) => m.id)
}

/**
 * Modo código: desfaz APENAS os caminhos que o turno mudou, comparando o
 * estado atual (C) com o estado final do turno (E) e o inicial (S).
 *
 * - C == E: o caminho ainda é o que o turno deixou → volta para S;
 * - C == S: já está desfeito → não faz nada;
 * - qualquer outro: alguém mexeu depois (outra conversa na mesma pasta, o
 *   usuário fora do Orbit) → preserva e reporta conflito.
 *
 * Nada de `restore` da pasta inteira: um turno de leitura não pode resetar o
 * repositório, e o trabalho de outra conversa não pode ser engolido.
 *
 * O truncamento já foi persistido por quem chama — se a restauração falhar, a
 * exceção NÃO pode subir: as mensagens ficariam cortadas sem barra de revert
 * nem unrevert. Devolve filesRestored:false com o motivo para a UI avisar.
 */
async function revertFiles(
  directory: string,
  messageId: string,
  discarded: ChatMessage[],
  snapshot: ChatMessage['snapshot'] | undefined,
): Promise<SessionRevert> {
  const start = snapshot?.start
  if (!start) {
    // Sem snapshot para esta mensagem: não há como restaurar o filesystem. Em
    // vez do fallback silencioso para "modo chat", sinaliza explicitamente que
    // os arquivos não puderam ser desfeitos.
    return { messageId, filesRestored: false, reason: 'no-snapshot', discardedMessages: discarded }
  }
  const end = snapshot?.end
  // Turno sem escrita: nada a desfazer. Não toca na pasta (antes, o restore
  // global voltava o repositório inteiro ao início de um turno só de leitura).
  // Com `end` presente, a pasta mudou por save manual do painel: a transição
  // roda com esses caminhos em `skip` e não desfaz nada deles.
  if (snapshot?.verified === 'unchanged' && !end) {
    return { messageId, filesRestored: true, discardedMessages: discarded }
  }
  if (!end) {
    // O turno pode ter escrito, mas o estado final não foi registrado (captura
    // falhou, crash). Sem E não há como distinguir a escrita do turno da de
    // outra pessoa — restaurar seria adivinhar.
    return { messageId, filesRestored: false, reason: 'no-end-snapshot', discardedMessages: discarded }
  }
  if (end === start) {
    return { messageId, filesRestored: true, discardedMessages: discarded }
  }

  try {
    // Estado imediatamente antes do revert — é o que o unrevert devolve.
    const current = await capture(directory).catch((err) => {
      console.error('[revert] captura do estado atual falhou (unrevert ficará sem arquivos):', err)
      return undefined
    })

    // Saves manuais do painel durante o turno não são obra do agente: entram
    // como conflito (preservados), nunca como revertidos.
    const manual = new Set(snapshot?.manual ?? [])
    const result = await transition(directory, end, start, manual)

    // Estado depois do revert — o unrevert só mexe no que ainda estiver aqui.
    // Sem nada aplicado, o estado pós-revert é o mesmo de antes (não há o que
    // desfazer); poupa uma captura inteira da pasta.
    const after =
      result.applied.length > 0
        ? await capture(directory).catch((err) => {
            console.error(
              '[revert] captura do estado pós-revert falhou (unrevert ficará sem arquivos):',
              err,
            )
            return undefined
          })
        : current

    const changes = await diffPaths(directory, start, end, result.applied).catch(() => ({
      files: result.applied,
      patch: '',
    }))

    return {
      messageId,
      snapshot: current,
      after,
      files: result.applied,
      conflicts: result.conflicts,
      diff: changes.patch,
      filesRestored: true,
      discardedMessages: discarded,
    }
  } catch (err) {
    console.error('[revert] falha ao restaurar o filesystem (truncamento já salvo):', err)
    return { messageId, filesRestored: false, reason: 'capture-failed', discardedMessages: discarded }
  }
}

export async function unrevert(sessionId: string): Promise<UnrevertResult> {
  const before = await loadSession(sessionId)
  if (!before?.revert) return { done: false }

  const work = async (): Promise<UnrevertResult> => {
    // Relê SOB a trava: um turno que entrou na frente pode ter consolidado o
    // revert (cleanupRevert) — aí não há mais o que desfazer, e usar o estado
    // lido antes da fila ressuscitaria mensagens que já foram descartadas.
    const session = await loadSession(sessionId)
    if (!session?.revert) return { done: false }
    const revertState = session.revert

    // Restaura mensagens descartadas (ambos os modos)
    if (revertState.discardedMessages) {
      const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
      const restored = [...messages, ...revertState.discardedMessages]
      await writeJson(StorageKeys.messages(sessionId), restored)
      broadcastChatEvent({ type: 'messages', sessionId, messages: restored })
    }

    // Modo código: devolve os arquivos com a MESMA regra de conflito. O
    // `after` é o estado que o revert deixou; se algo mudou desde então, o
    // caminho é preservado.
    let files: UnrevertResult['files']
    if (session.directory && revertState.snapshot) {
      try {
        if (revertState.after) {
          const result = await transition(session.directory, revertState.after, revertState.snapshot)
          files = { restored: result.applied.length, conflicts: result.conflicts }
        } else {
          files = {
            restored: 0,
            conflicts: ['(estado posterior do revert não registrado — arquivos preservados)'],
          }
        }
      } catch (err) {
        // As mensagens já voltaram; os arquivos ficam como estão e a falha
        // vira conflito visível em vez de uma promise rejeitada.
        console.error('[revert] unrevert dos arquivos falhou:', err)
        files = { restored: 0, conflicts: ['(falha ao restaurar os arquivos — preservados)'] }
      }
    }

    // Mídia: o redo guardado pelo revert (nos dois modos), com a mesma regra.
    const media = await unrevertMedia(sessionId)

    const next = { ...session }
    delete next.revert
    await saveSession(next)
    return { done: true, files, media }
  }

  return before.directory ? withWorkspaceLock(before.directory, work) : work()
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
