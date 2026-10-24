import type { BrowserWindow } from 'electron'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { dispatchAsk } from '../ask-dispatch'
import { newRequestId } from '../ask-broker'
import { runChat } from '../chat-engine'
import { broadcastSessionEvent } from '../companion-server'
import { createSubchatRecord } from '../subchats'

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
  if (win) {
    void runChat(win, {
      sessionId: child.id,
      text: KICKOFF[idiomaDe(input.language)],
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
    }).catch((err) => console.error('[subchat] turno inicial do filho falhou:', err))
  }
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
  }
}
