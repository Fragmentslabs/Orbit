import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { StorageKeys, type FolderInfo, type SessionInfo } from '@shared/chat'
import { listKeys, readJson, removeJson, writeJson } from '../storage'
import { broadcastSessionEvent } from '../companion-server'
import { abortChat } from '../chat-engine'

/**
 * Manutenção de chats pelo agente — a base das rotinas de limpeza.
 *
 * Arquivar é reversível e é o caminho padrão; excluir apaga mensagens e o
 * histórico de revert, então tem regras próprias (ver chat_delete).
 *
 * As sessões são mutadas aqui no main e o renderer acompanha pelos eventos
 * "session" / "session:deleted" / "folders", que ele já trata.
 */

const DIA_MS = 24 * 60 * 60 * 1000

/** Quantos chats uma única chamada de exclusão pode apagar. */
const LIMITE_EXCLUSAO = 25

async function carregarSessoes(): Promise<SessionInfo[]> {
  const chaves = await listKeys(StorageKeys.sessionPrefix)
  const itens = await Promise.all(chaves.map((k) => readJson<SessionInfo>(k)))
  return itens.filter((s): s is SessionInfo => s != null)
}

async function carregarPastas(): Promise<FolderInfo[]> {
  return (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
}

function diasInativo(sessao: SessionInfo, agora: number): number {
  return Math.floor((agora - sessao.updatedAt) / DIA_MS)
}

function descrever(sessao: SessionInfo, pastas: Map<string, string>, agora: number): string {
  const pasta = sessao.folderId ? pastas.get(sessao.folderId) : undefined
  const marcas = [
    sessao.pinned ? 'fixado' : null,
    sessao.archived ? 'arquivado' : null,
    pasta ? `pasta: ${pasta}` : null,
    sessao.directory ? `dir: ${sessao.directory}` : null,
  ].filter(Boolean)
  const extra = marcas.length ? ` (${marcas.join(', ')})` : ''
  return `#${sessao.id} [${sessao.mode}] ${diasInativo(sessao, agora)}d sem interação — "${sessao.title}"${extra}`
}

export function createSessionTools(): ToolSet {
  return {
    chat_list: tool({
      description: [
        'Lists the user\'s chats with how many days each has gone without interaction.',
        'This is the tool to call BEFORE archiving or deleting anything — it is the only way to know what exists.',
        'By default it hides pinned chats, archived chats, orchestration sub-sessions and routine runs,',
        'because none of those are candidates for cleanup.',
      ].join(' '),
      inputSchema: z.object({
        mode: z.enum(['chat', 'code']).optional().describe('Restricts to one workspace mode'),
        inactiveDays: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only chats untouched for at least this many days. Omit for all.'),
        includePinned: z
          .boolean()
          .optional()
          .describe('Default false. Pinned chats were explicitly protected by the user.'),
        includeArchived: z.boolean().optional().describe('Default false'),
        folder: z.string().optional().describe('Only chats in the folder with this exact name'),
        limit: z.number().int().min(1).max(200).optional().describe('Default: 50'),
      }),
      execute: async ({ mode, inactiveDays, includePinned, includeArchived, folder, limit }) => {
        const agora = Date.now()
        const [sessoes, pastas] = await Promise.all([carregarSessoes(), carregarPastas()])
        const nomePorId = new Map(pastas.map((f) => [f.id, f.name]))
        const idsDaPasta = folder
          ? new Set(pastas.filter((f) => f.name === folder).map((f) => f.id))
          : null

        const filtradas = sessoes
          .filter((s) => {
            if (mode && s.mode !== mode) return false
            if (!includePinned && s.pinned) return false
            if (!includeArchived && s.archived) return false
            // Workers de orquestração e execuções de rotina não são chats do
            // usuário: pertencem a outra sessão ou à rotina que os criou.
            if (s.parentId || s.routineId) return false
            if (idsDaPasta && (!s.folderId || !idsDaPasta.has(s.folderId))) return false
            if (inactiveDays != null && diasInativo(s, agora) < inactiveDays) return false
            return true
          })
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, limit ?? 50)

        if (filtradas.length === 0) return 'Nenhum chat corresponde a esses critérios.'
        return [
          `${filtradas.length} chat(s), do mais antigo para o mais recente:`,
          ...filtradas.map((s) => descrever(s, nomePorId, agora)),
        ].join('\n')
      },
    }),

    chat_archive: tool({
      description: [
        'Archives chats by id (or unarchives with archived=false). Archiving is REVERSIBLE:',
        'the chat leaves the sidebar and its messages are kept untouched. Prefer this over deleting.',
        'The chat keeps its folder, so it appears under that folder inside the archived group and',
        'returns to its place if unarchived. Pinned chats are refused — unpin first if that is really the intent.',
      ].join(' '),
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(200).describe('Chat ids from chat_list'),
        archived: z.boolean().optional().describe('Default true. Pass false to unarchive.'),
      }),
      execute: async ({ ids, archived }) => {
        const alvo = archived ?? true
        const resultados: string[] = []
        let alterados = 0
        for (const id of ids) {
          const sessao = await readJson<SessionInfo>(StorageKeys.session(id))
          if (!sessao) {
            resultados.push(`#${id}: não encontrado`)
            continue
          }
          if (sessao.pinned && alvo) {
            resultados.push(`#${id}: fixado pelo usuário — não arquivado`)
            continue
          }
          if (sessao.archived === alvo) continue
          const proxima: SessionInfo = { ...sessao, archived: alvo }
          await writeJson(StorageKeys.session(id), proxima)
          broadcastSessionEvent({ type: 'session', sessionId: id, session: proxima })
          alterados++
        }
        const verbo = alvo ? 'arquivado(s)' : 'desarquivado(s)'
        return [`${alterados} chat(s) ${verbo}.`, ...resultados].join('\n')
      },
    }),

    chat_delete: tool({
      description: [
        'PERMANENTLY deletes chats: messages, plan reviews and revert history go with them, and nothing can be recovered.',
        'Only use it when the user asked for deletion in those words — for cleanup, chat_archive is the correct tool',
        'and achieves the same tidy sidebar while remaining reversible.',
        'Call chat_list first and read the titles: deleting something the user still needed is not fixable.',
        'Pinned chats are always refused. At most 25 per call.',
      ].join(' '),
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).describe('Chat ids from chat_list'),
        motivo: z
          .string()
          .min(10)
          .describe(
            'Why deleting (not archiving) is right for THESE chats. Written out so the decision is deliberate and auditable.',
          ),
      }),
      execute: async ({ ids, motivo }) => {
        if (ids.length > LIMITE_EXCLUSAO) {
          return `Erro: ${ids.length} chats numa só chamada excede o limite de ${LIMITE_EXCLUSAO}. Exclusão é irreversível — reveja a lista e faça em lotes menores.`
        }
        const resultados: string[] = []
        let apagados = 0
        for (const id of ids) {
          const sessao = await readJson<SessionInfo>(StorageKeys.session(id))
          if (!sessao) {
            resultados.push(`#${id}: não encontrado`)
            continue
          }
          if (sessao.pinned) {
            resultados.push(`#${id}: fixado pelo usuário — não excluído`)
            continue
          }
          // Encerra o que estiver rodando antes de apagar: um stream órfão
          // continuaria escrevendo numa sessão que não existe mais.
          abortChat(id)
          await removeJson(StorageKeys.session(id))
          await removeJson(StorageKeys.messages(id))
          await removeJson(StorageKeys.planReview(id))
          await removeJson(StorageKeys.pendingAsks(id))
          broadcastSessionEvent({ type: 'session:deleted', sessionId: id })
          apagados++
        }
        return [`${apagados} chat(s) excluído(s) permanentemente. Motivo: ${motivo}`, ...resultados].join('\n')
      },
    }),
  }
}
