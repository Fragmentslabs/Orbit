import type { BrowserWindow } from 'electron'
import type { AskItem, ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { reply as askReply } from './ask-broker'
import { readAppLanguage } from './app-language'
import { listCredentialProviders } from './auth'
import { broadcastChatEvent } from './broadcast'
import { runChat } from './chat-engine'
import { listKeys, readJson, removeJson, writeJson } from './storage'

/**
 * Retomada de um pedido que já não está mais no broker.
 *
 * O ask-broker vive em memória: quando a execução termina (abort, erro, app
 * reiniciado), a promise que aguardava a resposta morre junto. O card, porém,
 * é persistido em `pendingAsks/` e volta a aparecer ao reabrir a conversa — nos
 * dois apps. Responder ali não tinha para onde ir: o card fechava e nada
 * acontecia.
 *
 * Em vez de descartar a resposta, ela vira uma nova mensagem do usuário na
 * mesma sessão, com a pergunta original ao lado — o agente retoma de onde
 * parou já sabendo o que foi decidido. Dispensar/negar continua sendo só
 * descartar o card: ninguém quer acordar o agente para dizer "deixa pra lá".
 *
 * As respostas são coalescidas por sessão numa janela curta porque um lote de
 * perguntas de workers (modo orquestra) fecha vários cards de uma vez — sem
 * isso seriam N execuções concorrentes na mesma conversa.
 */

const JANELA_MS = 400

type PedidoSalvo = AskItem & { batchId?: string }

interface QuestionReply {
  answers?: string[]
  rejected?: boolean
}

interface Fila {
  win: BrowserWindow
  blocos: string[]
  timer: NodeJS.Timeout
}

const filas = new Map<string, Fila>()

const TEXTOS = {
  pt: {
    cabecalho:
      'Retomando um pedido que ficou pendente: a execução anterior terminou antes de eu responder. Segue o que ficou decidido:',
    rodape: 'Continue de onde parou, considerando isto.',
    autorizo: 'Autorizo a ação',
    semResposta: '(sem resposta)',
    worker: 'worker',
  },
  en: {
    cabecalho:
      'Resuming a pending request: the previous run ended before I answered. Here is what was decided:',
    rodape: 'Continue from where you stopped, taking this into account.',
    autorizo: 'I authorize the action',
    semResposta: '(no answer)',
    worker: 'worker',
  },
} as const

type Textos = (typeof TEXTOS)['pt' | 'en']

/** Pedido persistido em disco — o broker só conhece os que ainda estão vivos. */
async function localizar(
  requestId: string,
): Promise<{ chave: string; sessionId: string; item: PedidoSalvo; todos: PedidoSalvo[] } | null> {
  const chaves = await listKeys('pendingAsks/')
  for (const chave of chaves) {
    const todos = await readJson<PedidoSalvo[]>(chave)
    const item = todos?.find((i) => i.requestId === requestId)
    if (item && todos) {
      return { chave, sessionId: chave.slice('pendingAsks/'.length), item, todos }
    }
  }
  return null
}

/** Tira o card do disco e de todas as UIs (desktop e companions). */
async function encerrarCard(
  chave: string,
  sessionId: string,
  requestId: string,
  todos: PedidoSalvo[],
): Promise<void> {
  const resto = todos.filter((i) => i.requestId !== requestId)
  if (resto.length > 0) await writeJson(chave, resto)
  else await removeJson(chave)
  broadcastChatEvent({ type: 'ask:done', sessionId, requestId })
}

function blocoDaResposta(item: PedidoSalvo, value: unknown, textos: Textos): string | null {
  // Pergunta de worker: o pedido foi feito ao chat do orquestrador, e o worker
  // que perguntou já não existe — dizer de quem era evita que o agente leia as
  // respostas como se fossem do próprio turno dele.
  const origem = item.origin ? `[${textos.worker}: ${item.origin.workerTitle}] ` : ''

  if (item.kind === 'permission') {
    // 'deny' não gera mensagem: negar um pedido morto é só limpar a tela.
    if (value !== 'allow' && value !== 'always' && value !== 'always_chat') return null
    return `${origem}${textos.autorizo}: ${item.claim?.title ?? ''}`.trim()
  }

  const resposta = value as QuestionReply | undefined
  if (resposta?.rejected || !Array.isArray(resposta?.answers)) return null
  const perguntas = item.questions ?? []
  if (perguntas.length === 0) return null
  const linhas = perguntas
    .map((q, i) => `${i + 1}. ${q.text}\n   → ${resposta.answers?.[i] || textos.semResposta}`)
    .join('\n')
  return origem ? `${origem.trim()}\n${linhas}` : linhas
}

/** Modelo, modo e permissões do último turno — retomar não pode trocar o
 *  modelo da conversa por um padrão qualquer. */
async function montarInput(
  sessionId: string,
  session: SessionInfo,
  text: string,
): Promise<SendMessageInput> {
  const mensagens = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const ultimaComModelo = [...mensagens].reverse().find((m) => m.providerId && m.modelId)
  const ultimaDoUsuario = [...mensagens].reverse().find((m) => m.role === 'user')
  const conectados = await listCredentialProviders()
  const idioma = await readAppLanguage()

  return {
    sessionId,
    text,
    providerId: ultimaComModelo?.providerId ?? conectados[0] ?? 'openai',
    modelId: ultimaComModelo?.modelId ?? 'gpt-4o',
    mode: session.mode,
    options: { permissionMode: ultimaDoUsuario?.permissionMode },
    directory: session.directory,
    extraDirectories: session.extraDirectories,
    ...(idioma ? { language: idioma } : {}),
  }
}

async function despachar(sessionId: string): Promise<void> {
  const fila = filas.get(sessionId)
  if (!fila) return
  filas.delete(sessionId)
  if (fila.blocos.length === 0) return

  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) return

  const idioma = await readAppLanguage()
  const textos = idioma === 'English' ? TEXTOS.en : TEXTOS.pt
  const text = [textos.cabecalho, '', fila.blocos.join('\n\n'), '', textos.rodape].join('\n')

  const input = await montarInput(sessionId, session, text)
  console.log(`[ask] retomando ${fila.blocos.length} resposta(s) pendente(s) na sessão ${sessionId}`)
  void runChat(fila.win, input)
}

/**
 * Responde ao pedido vivo; se ele já não existe, retoma pela conversa.
 * Retorna false só quando não há nem pedido vivo nem card salvo — aí a UI
 * descarta o card, porque não sobrou nada para responder.
 */
export async function replyOrResume(
  win: BrowserWindow | null,
  requestId: string,
  value: unknown,
): Promise<boolean> {
  if (askReply(requestId, value)) return true

  const salvo = await localizar(requestId)
  if (!salvo) return false

  const { chave, sessionId, item, todos } = salvo
  await encerrarCard(chave, sessionId, requestId, todos)

  const idioma = await readAppLanguage()
  const bloco = blocoDaResposta(item, value, idioma === 'English' ? TEXTOS.en : TEXTOS.pt)
  // Dispensa/negação: o card já saiu, e não há nada a dizer ao agente.
  if (!bloco || !win || win.isDestroyed()) return true

  const fila = filas.get(sessionId)
  if (fila) {
    fila.blocos.push(bloco)
    return true
  }
  filas.set(sessionId, {
    win,
    blocos: [bloco],
    timer: setTimeout(() => void despachar(sessionId), JANELA_MS),
  })
  return true
}
