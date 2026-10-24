import type { ChatMessage, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { listKeys, readJson, writeJson } from './storage'
import { SUMMARY_PREFIX } from './compaction'

/**
 * Subchats: conversas abertas a partir de outra, com contexto próprio.
 *
 * O filho guarda o pai (`parentId`), mas o pai precisa da lista INVERSA a cada
 * turno. Não há índice persistido: um scan por turno custa menos do que manter
 * um arquivo sincronizado por dois escritores (o renderer cria o filho do card,
 * o main cria o da tool) — e o parentId nunca muda depois de criado.
 */

const MAX_SUBCHATS = 8
/** Quanto do último resultado do filho entra no contexto do pai. */
const MAX_RESULTADO = 600
/** Sem resultado ainda, o brief serve de resumo (é o que o filho sabe). */
const MAX_BRIEF = 400

function novoId(prefixo: string): string {
  return `${prefixo}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Todo o texto de uma mensagem, sem o marcador de resumo. */
function textoDaMensagem(message: ChatMessage): string {
  const texto = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('\n')
    .trim()
  return texto.startsWith(SUMMARY_PREFIX) ? texto.slice(SUMMARY_PREFIX.length).trim() : texto
}

function tempoRelativo(quando: number): string {
  const min = Math.round((Date.now() - quando) / 60_000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  const horas = Math.round(min / 60)
  if (horas < 24) return `${horas}h ago`
  return `${Math.round(horas / 24)}d ago`
}

export interface SubchatResumo {
  session: SessionInfo
  /** O que o filho produziu por último — ou o brief, se ainda não rodou. */
  resultado?: string
}

/** Filhos de uma conversa, do mais recente para o mais antigo. */
export async function listSubchats(parentId: string): Promise<SubchatResumo[]> {
  const chaves = await listKeys(StorageKeys.sessionPrefix)
  const sessoes = (await Promise.all(chaves.map((k) => readJson<SessionInfo>(k)))).filter(
    (s): s is SessionInfo =>
      // Workers de orquestração também têm parentId, mas já são assunto do
      // workers.ts (read_worker/message_worker) — aqui só conversas anexadas.
      s != null && s.parentId === parentId && !s.archived && s.orchestration?.role !== 'worker',
  )
  sessoes.sort((a, b) => b.updatedAt - a.updatedAt)

  return Promise.all(
    sessoes.slice(0, MAX_SUBCHATS).map(async (session) => {
      const mensagens = (await readJson<ChatMessage[]>(StorageKeys.messages(session.id))) ?? []
      const assistente = [...mensagens].reverse().find((m) => m.role === 'assistant' && !m.summary)
      const brief = [...mensagens].reverse().find((m) => m.summary)
      const resultado = assistente
        ? textoDaMensagem(assistente)
        : brief
          ? textoDaMensagem(brief).slice(0, MAX_BRIEF)
          : ''
      return { session, resultado: resultado || undefined }
    }),
  )
}

export interface NovoSubchat {
  parentId: string
  title: string
  /** O texto que abre o chat novo (o brief). Vira a mensagem de resumo. */
  body: string
}

/**
 * Cria o filho com o brief como mensagem de abertura — um resumo do sistema,
 * para o modelo do chat novo ler como contexto e a UI mostrar como card.
 * Herda modo, pasta e pastas extras do pai: o trabalho continua no mesmo lugar.
 */
export async function createSubchatRecord({ parentId, title, body }: NovoSubchat): Promise<SessionInfo | null> {
  const pai = await readJson<SessionInfo>(StorageKeys.session(parentId))
  if (!pai) return null

  const now = Date.now()
  const filho: SessionInfo = {
    id: novoId('ses'),
    title: title.trim().slice(0, 80) || 'Subchat',
    mode: pai.mode,
    pinned: false,
    archived: false,
    folderId: pai.folderId,
    directory: pai.directory,
    extraDirectories: pai.extraDirectories,
    parentId,
    createdAt: now,
    updatedAt: now,
  }

  const abertura: ChatMessage = {
    id: novoId('msg'),
    role: 'assistant',
    summary: true,
    continuation: true,
    parts: [
      {
        id: novoId('prt'),
        type: 'text',
        text: `${SUMMARY_PREFIX}\n\n${body.trim()}`,
        state: 'done',
      },
    ],
    createdAt: now,
  }

  await writeJson(StorageKeys.session(filho.id), filho)
  await writeJson(StorageKeys.messages(filho.id), [abertura])
  return filho
}

/** O bloco do system prompt: o pai enxerga o RESULTADO de cada filho. */
export function formatSubchatsBlock(resumos: SubchatResumo[]): string {
  if (resumos.length === 0) return ''
  const linhas = resumos.map(({ session, resultado }) => {
    const limite = resultado && resultado.length > MAX_RESULTADO
      ? `${resultado.slice(0, MAX_RESULTADO).replace(/\s+/g, ' ')}…`
      : resultado?.replace(/\s+/g, ' ')
    return `- **${session.title}** (opened ${tempoRelativo(session.createdAt)})${limite ? `\n  Latest: ${limite}` : ''}`
  })
  return [
    '## Subchats opened from this conversation',
    'Separate conversations with their own context, attached to this one. You see each one\'s LATEST result here — never its history. Stay consistent with what they did and do not redo their work; when the user asks about one, answer from this line and point them to the chat.',
    ...linhas,
  ].join('\n')
}
