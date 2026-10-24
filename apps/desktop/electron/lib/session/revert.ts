import type { ChatMessage, RevertFileTurn, SessionInfo, SessionRevert, UnrevertResult } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { broadcastChatEvent } from '../broadcast'
import { capture, changedPaths, diffPaths, transition } from '../snapshot'
import { readJson, writeJson } from '../storage'
import { discardMediaRevert, revertMedia, unrevertMedia } from './media-revert'
import { withWorkspaceLock } from './workspace-lock'
import { coveredBy } from './write-journal'

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

    const revertState: SessionRevert = session.directory
      ? await revertFiles(session.directory, messageId, discarded)
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

type FileTurns = { turns: RevertFileTurn[] } | { reason: 'no-snapshot' | 'no-end-snapshot' }

/**
 * Os turnos descartados que mexeram na pasta, do ÚLTIMO para o primeiro — a
 * ordem em que precisam ser desfeitos: o turno 2 volta ao começo dele (que é
 * o fim do turno 1), e só então o turno 1 volta ao começo dele. Desfazer só o
 * primeiro deixava de fora o que o segundo criou, e um arquivo que os dois
 * editaram virava conflito falso.
 *
 * Os caminhos de autoria confirmada são os que as tools do turno gravaram
 * (`snapshot.authored`); os que outra conversa gravou no intervalo
 * (`snapshot.others`) ficam fora; o resto do diff é de autor incerto (bash,
 * MCP, algo de fora). Turno anterior ao diário (sem `authored`): todo o diff
 * conta como dele, como antes.
 */
async function fileTurnsOf(directory: string, discarded: ChatMessage[]): Promise<FileTurns> {
  const withSnapshot = discarded.filter((m) => m.role === 'assistant' && m.snapshot)
  if (withSnapshot.length === 0) return { reason: 'no-snapshot' }
  const turns: RevertFileTurn[] = []
  for (const message of [...withSnapshot].reverse()) {
    const snapshot = message.snapshot!
    const { start, end } = snapshot
    // Sem `start` não há estado a que voltar.
    if (!start) return { reason: 'no-snapshot' }
    // Turno sem escrita: nada a desfazer, e a pasta não é tocada. Com `end`,
    // a pasta mudou por save manual ou por outra conversa: a transição roda e
    // separa o que é do turno.
    if (snapshot.verified === 'unchanged' && !end) continue
    // O turno pode ter escrito, mas o estado final não foi registrado (captura
    // falhou, crash). Sem E não há como distinguir a escrita do turno da de
    // outra pessoa — restaurar seria adivinhar.
    if (!end) return { reason: 'no-end-snapshot' }
    if (end === start) continue

    const manual = snapshot.manual ?? []
    const all = await changedPaths(directory, end, start)
    if (!snapshot.authored) {
      turns.push({ from: end, to: start, paths: all, uncertain: [], manual })
      continue
    }
    const authored = snapshot.authored
    const others = snapshot.others ?? []
    const paths: string[] = []
    const uncertain: string[] = []
    for (const rel of all) {
      if (coveredBy(rel, authored) || manual.includes(rel)) paths.push(rel)
      else if (!coveredBy(rel, others)) uncertain.push(rel)
    }
    turns.push({ from: end, to: start, paths, uncertain, manual })
  }
  return { turns }
}

interface AppliedTurns {
  applied: string[]
  conflicts: string[]
}

/** Aplica os turnos em ordem (do último para o primeiro) com a regra S/E/C. */
async function applyTurns(directory: string, turns: RevertFileTurn[], withUncertain: boolean): Promise<AppliedTurns> {
  const applied = new Set<string>()
  const conflicts = new Set<string>()
  for (const turn of turns) {
    const paths = withUncertain ? [...turn.paths, ...turn.uncertain] : turn.paths
    if (paths.length === 0) continue
    // Saves manuais do painel durante o turno não são obra do agente: entram
    // como conflito (preservados), nunca como revertidos.
    const result = await transition(directory, turn.from, turn.to, { skip: new Set(turn.manual), paths })
    for (const rel of result.applied) applied.add(rel)
    for (const rel of result.conflicts) conflicts.add(rel)
  }
  for (const rel of applied) conflicts.delete(rel)
  return { applied: [...applied].sort(), conflicts: [...conflicts].sort() }
}

function uniqueUncertain(turns: RevertFileTurn[]): string[] {
  return [...new Set(turns.flatMap((t) => t.uncertain))].sort()
}

/** Estado pós-revert e o diff do que foi desfeito. Sem nada aplicado, o pós é o pré. */
async function afterAndDiff(
  directory: string,
  current: string,
  applied: string[],
): Promise<{ after?: string; diff: string }> {
  if (applied.length === 0) return { after: current, diff: '' }
  const after = await capture(directory).catch((err) => {
    console.error('[revert] captura do estado pós-revert falhou (unrevert ficará sem arquivos):', err)
    return undefined
  })
  // De depois para antes do revert: é o que os turnos tinham feito nesses caminhos.
  const changes = after
    ? await diffPaths(directory, after, current, applied).catch(() => ({ files: applied, patch: '' }))
    : { files: applied, patch: '' }
  return { after, diff: changes.patch }
}

/**
 * Modo código: desfaz APENAS os caminhos que os turnos descartados mudaram e
 * que as tools deles gravaram, comparando o estado atual (C) com o fim (E) e
 * o começo (S) de cada turno.
 *
 * - C == E: o caminho ainda é o que o turno deixou → volta para S;
 * - C == S: já está desfeito → não faz nada;
 * - qualquer outro: alguém mexeu depois (outra conversa na mesma pasta, o
 *   usuário fora do Orbit) → preserva e reporta conflito.
 *
 * Os caminhos de autor incerto ficam como estão e vão para `uncertain`.
 *
 * O truncamento já foi persistido por quem chama — se a restauração falhar, a
 * exceção NÃO pode subir: as mensagens ficariam cortadas sem barra de revert
 * nem unrevert. Devolve filesRestored:false com o motivo para a UI avisar.
 */
async function revertFiles(
  directory: string,
  messageId: string,
  discarded: ChatMessage[],
): Promise<SessionRevert> {
  try {
    const found = await fileTurnsOf(directory, discarded)
    if ('reason' in found) {
      return { messageId, filesRestored: false, reason: found.reason, discardedMessages: discarded }
    }
    const { turns } = found
    if (turns.length === 0) return { messageId, filesRestored: true, discardedMessages: discarded }

    // Estado imediatamente antes do revert — é o que o unrevert devolve. Sem
    // ele, NADA é tocado: aplicar a transição mesmo assim deixaria arquivos
    // desfeitos sem caminho de volta (e o unrevert, sem `snapshot`, não
    // avisaria). A falha sobe para o catch abaixo → 'capture-failed'.
    const current = await capture(directory)
    const result = await applyTurns(directory, turns, false)
    const { after, diff } = await afterAndDiff(directory, current, result.applied)
    const uncertain = uniqueUncertain(turns)

    return {
      messageId,
      snapshot: current,
      after,
      files: result.applied,
      conflicts: result.conflicts,
      ...(uncertain.length > 0 ? { uncertain, fileTurns: turns } : {}),
      diff,
      filesRestored: true,
      discardedMessages: discarded,
    }
  } catch (err) {
    console.error('[revert] falha ao restaurar o filesystem (truncamento já salvo):', err)
    return { messageId, filesRestored: false, reason: 'capture-failed', discardedMessages: discarded }
  }
}

/**
 * "Reverter também" os caminhos de autor incerto do revert ativo. Refaz a
 * cadeia de turnos inteira com eles incluídos: o que já foi desfeito volta
 * como "já está" (nada a fazer), e um caminho de autoria confirmada que tinha
 * dado conflito por causa de um incerto (o bash do turno seguinte mexeu nele)
 * agora pode voltar também. A mesma regra S/E/C vale: o que mudou depois do
 * turno continua preservado.
 */
export async function revertUncertain(sessionId: string): Promise<SessionRevert | null> {
  const before = await loadSession(sessionId)
  if (!before?.directory || !before.revert?.fileTurns) return null
  const directory = before.directory
  return withWorkspaceLock(directory, async () => {
    const session = await loadSession(sessionId)
    const state = session?.revert
    if (!session || !state?.fileTurns || !state.snapshot) return null
    try {
      const result = await applyTurns(directory, state.fileTurns, true)
      const applied = [...new Set([...(state.files ?? []), ...result.applied])].sort()
      const conflicts = [...new Set([...(state.conflicts ?? []), ...result.conflicts])]
        .filter((rel) => !applied.includes(rel))
        .sort()
      const { after, diff } = await afterAndDiff(directory, state.snapshot, applied)
      const next: SessionRevert = { ...state, files: applied, conflicts, after, diff }
      delete next.uncertain
      delete next.fileTurns
      await saveSession({ ...session, revert: next })
      return next
    } catch (err) {
      console.error('[revert] revert dos caminhos incertos falhou:', err)
      return state
    }
  })
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
          // Sem o estado pós-revert não dá para saber o que mudou depois dele.
          files = { restored: 0, conflicts: [], error: 'no-after' }
        }
      } catch (err) {
        // As mensagens já voltaram; os arquivos ficam como estão e a falha
        // vira conflito visível em vez de uma promise rejeitada.
        console.error('[revert] unrevert dos arquivos falhou:', err)
        files = { restored: 0, conflicts: [], error: 'failed' }
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
