import type { BrowserWindow } from 'electron'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput, SessionInfo } from '@shared/chat'
import { dispatchAsk } from '../ask-dispatch'
import { newRequestId } from '../ask-broker'
import { getRunningSessionIds, runChat } from '../chat-engine'
import { broadcastSessionEvent } from '../companion-server'
import { createSubchatRecord, findSubchat, readSubchatMessages } from '../subchats'
import { detachFromTurn } from '../session/write-journal'

/**
 * Primeira mensagem do chat novo, na voz de quem autorizou a abertura: o filho
 * começa a trabalhar sozinho, então o resumo (o brief) é o contexto e esta
 * linha só manda seguir.
 */
const KICKOFF = {
  pt: 'Pode começar. Trabalhe até concluir — o resumo acima tem o contexto, então não pare para perguntar o que ele já responde.',
  en: "Go ahead. Work through to the end — the summary above has the context, so don't stop to ask what it already answers.",
}

type Idioma = keyof typeof KICKOFF

function idiomaDe(language?: string): Idioma {
  return (language ?? '').toLowerCase().startsWith('port') ? 'pt' : 'en'
}

/** Cabeçalho da instrução do pai: no chat do filho a mensagem não parece do usuário. */
const FROM_PARENT = {
  pt: 'Mensagem do chat principal: ',
  en: 'Message from the main chat: ',
}

/**
 * Dispara um turno no filho, em paralelo ao do pai e sem esperar por ele. O
 * filho é OUTRA conversa na mesma pasta, com revert próprio: roda fora do
 * escopo de escrita do pai, senão o que ele grava contaria como obra do turno
 * do pai.
 */
function startChildTurn(input: SendMessageInput, win: BrowserWindow, child: SessionInfo, text: string): void {
  void detachFromTurn(() => runChat(win, {
    sessionId: child.id,
    text,
    providerId: input.providerId,
    modelId: input.modelId,
    mode: child.mode,
    options: {
      permissionMode: input.options.permissionMode,
      followGlobalPermission: input.options.followGlobalPermission,
      reasoning: input.options.reasoning,
    },
    directory: child.directory,
    extraDirectories: child.extraDirectories,
    visionModel: input.visionModel,
    language: input.language,
  })).catch((err) => console.error('[subchat] turno do filho falhou:', err))
}

/**
 * Cria o filho e dispara o turno dele, em paralelo ao turno do pai. Devolve o
 * texto que a tool entrega ao modelo.
 */
async function abrirEIniciar(
  input: SendMessageInput,
  win: BrowserWindow | undefined,
  title: string,
  brief: string,
): Promise<string> {
  const child = await createSubchatRecord({ parentId: input.sessionId, title, body: brief })
  if (!child) return 'Error: the current conversation could not be found, so no subchat was opened.'
  broadcastSessionEvent({ type: 'session', sessionId: child.id, session: child })
  if (win) startChildTurn(input, win, child, KICKOFF[idiomaDe(input.language)])
  return `Subchat opened: "${child.title}" (#${child.id}). It is attached to this conversation, starts from your brief and is already working on it in parallel.`
}

const TITLE_INPUT = z
  .string()
  .min(3)
  .max(80)
  .describe("Short title for the new chat, in the user's language")

const BRIEF_INPUT = z
  .string()
  .min(20)
  .describe(
    "The opening message of the new chat, in the user's language: the goal, what is already done and " +
      'verified, the files that matter with exact paths, and the next concrete step. It must stand alone — ' +
      'the new chat has none of this conversation.',
  )

export function createSubchatTools(input: SendMessageInput, win?: BrowserWindow): ToolSet {
  // Instruções do mesmo passo ao mesmo filho: a segunda recusa (ver send_to_subchat).
  const inFlight = new Set<string>()

  return {
    suggest_subchat: tool({
      description: [
        'Suggests moving work that does not belong in this conversation to its own chat — a separate task,',
        'a side problem, anything that would drag unrelated context in here. Use this by DEFAULT: never open',
        'a chat on your own. Write the title and the brief you would use, and the user decides — open a new',
        'chat (it starts working from your brief right away), do it here, or leave it aside.',
        'This is also the answer when the conversation is getting long: a fresh context does not summarize a',
        'summary — but the choice is always the user\'s.',
      ].join(' '),
      inputSchema: z.object({ title: TITLE_INPUT, brief: BRIEF_INPUT }),
      execute: async ({ title, brief }, { abortSignal }) => {
        if (!win) return 'Error: the suggestion needs the app window.'
        let answer: string
        try {
          answer = await dispatchAsk<string>(
            input.sessionId,
            { requestId: newRequestId(), kind: 'subchat', subchat: { title, brief } },
            abortSignal,
          )
        } catch {
          // Turno abortado (stop) ou app fechado: ninguém respondeu. Não abre
          // nada — o agente não pode decidir no lugar da pessoa.
          return 'The suggestion was cancelled before the user answered — do not open a chat and leave that work aside.'
        }
        if (answer === 'new') return abrirEIniciar(input, win, title, brief)
        if (answer === 'here') {
          return 'The user chose to do it in THIS conversation. Do it here now, without opening a chat.'
        }
        return 'The user declined: do not open a chat and leave that work aside for now.'
      },
    }),

    open_subchat: tool({
      description: [
        'Opens a new chat attached to this one and starts working in it immediately, from the brief you',
        'write. Use it ONLY when the user explicitly asked for a new chat ("do this in a new chat",',
        '"open a chat for this") — otherwise use suggest_subchat and let them choose. Never open a subchat',
        'on your own initiative.',
      ].join(' '),
      inputSchema: z.object({ title: TITLE_INPUT, brief: BRIEF_INPUT }),
      execute: async ({ title, brief }) => abrirEIniciar(input, win, title, brief),
    }),

    read_subchat: tool({
      description: [
        'Reads a subchat you opened from this conversation: its most recent messages, oldest first,',
        'with tool calls shown by name. Use it when the "Latest" line in the subchats list is not enough',
        '(what it found, where it stopped, whether it failed). Read-only.',
      ].join(' '),
      inputSchema: z.object({
        subchatId: z.string().describe('The id from the subchats list'),
        last: z.number().int().min(1).max(40).optional().describe('How many of the most recent messages. Default 10'),
        skip: z.number().int().min(0).optional().describe('Skip this many of the most recent messages, to page back. Default 0'),
      }),
      execute: async ({ subchatId, last, skip }) => {
        const child = await findSubchat(input.sessionId, subchatId)
        if (!child) return `No subchat ${subchatId} attached to this conversation. Use an id from the subchats list.`
        const reading = await readSubchatMessages(child.id, last ?? 10, skip ?? 0)
        const status = getRunningSessionIds().includes(child.id) ? 'running a turn now' : 'idle'
        if (reading.messages.length === 0) return `"${child.title}" (${status}) has ${reading.total} messages — nothing in that range.`
        const rendered = reading.messages.map((m) =>
          [
            `### #${m.index} ${m.role === 'assistant' ? 'subchat' : 'user/main chat'}${m.error ? ` — ERROR: ${m.error}` : ''}`,
            m.tools.length > 0 ? `[tools: ${m.tools.join(', ')}]` : '',
            m.text,
          ].filter(Boolean).join('\n'),
        )
        return `Subchat "${child.title}" (${status}) — messages ${reading.from}-${reading.to} of ${reading.total}\n\n${rendered.join('\n\n')}`
      },
    }),

    send_to_subchat: tool({
      description: [
        'Sends a new instruction to a subchat you opened and lets it work on it in parallel, in its own',
        'context — it remembers everything it did there. The user is asked to approve every instruction before it',
        'goes. Prefer this over opening a new subchat when one already has the context (a fix, a follow-up, the next',
        'step). It does not wait for the reply: the subchat\'s result shows up in the subchats list on your next turn,',
        'or read it with read_subchat. A subchat that is still running a turn is refused — wait or read it first.',
      ].join(' '),
      inputSchema: z.object({
        subchatId: z.string().describe('The id from the subchats list'),
        message: z.string().min(5).describe(
          "The instruction, in the user's language. The subchat already has its own context — say what changed or what to do next, not the whole story again.",
        ),
      }),
      execute: async ({ subchatId, message }) => {
        if (!win) return 'Error: sending to a subchat needs the app window.'
        const child = await findSubchat(input.sessionId, subchatId)
        if (!child) return `No subchat ${subchatId} attached to this conversation. Use an id from the subchats list.`
        if (inFlight.has(child.id) || getRunningSessionIds().includes(child.id)) {
          return `Subchat "${child.title}" is busy right now (running a turn). Do not send anything yet — read it with read_subchat or try again later.`
        }
        // Marca antes de disparar: duas chamadas paralelas no mesmo passo
        // disputariam o chat do filho. Solta logo — o turno em si vive no engine.
        inFlight.add(child.id)
        try {
          startChildTurn(input, win, child, FROM_PARENT[idiomaDe(input.language)] + message.trim())
        } finally {
          setTimeout(() => inFlight.delete(child.id), 1_000)
        }
        return `Instruction sent to "${child.title}" (#${child.id}). It is working on it in parallel — its result appears in the subchats list on your next turn, or read it with read_subchat.`
      },
    }),
  }
}
