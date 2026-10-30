import type { BrowserWindow } from 'electron'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput, SessionInfo } from '@shared/chat'
import { dispatchAsk } from '../ask-dispatch'
import { newRequestId } from '../ask-broker'
import { getRunningSessionIds, runChat } from '../chat-engine'
import { broadcastChatEvent } from '../broadcast'
import { broadcastSessionEvent } from '../companion-server'
import { createContinuationRecord, createSubchatRecord, findSubchat, readSubchatMessages } from '../subchats'
import { detachFromTurn } from '../session/write-journal'
import { tNow } from '../i18n'

// The first message of the new chat (`subchat.kickoff`) is in the voice of whoever
// authorized the opening: the child starts working on its own, so the summary
// (the brief) is the context and that line only says to go ahead. The parent's
// later instructions carry `subchat.fromParent`, so in the child's chat they do
// not look like the user's. Both follow the app language (`electron/lib/i18n.ts`).

/**
 * Fires a turn in the child, in parallel to the parent's and without waiting for it. The
 * child is ANOTHER conversation in the same folder, with its own revert: it runs outside the
 * parent's write scope, otherwise what it writes would count as the work of the parent's
 * turn.
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
  })).catch((err) => console.error('[subchat] child turn failed:', err))
}

/** Where the suggestion is going: attached to this conversation, or a new top-level chat. */
type Scope = 'subchat' | 'chat'

/**
 * The model of the chat that opened it, pinned on the new conversation. The per-chat
 * model lives in the renderer (localStorage) — this is the same channel the companion
 * uses to select a model, so the new chat does not fall into the global default when the
 * next message is sent from the UI.
 */
function pinModel(win: BrowserWindow, sessionId: string, providerId: string, modelId: string): void {
  if (!win.webContents || win.isDestroyed?.()) return
  win.webContents.send('companion:model-select', { providerId, modelId, sessionId })
}

/**
 * Creates the conversation and fires its turn, in parallel to the parent's turn. Returns the
 * text the tool delivers to the model.
 *
 * `scope` decides the shape: "subchat" hangs from the person's chat; "chat" is a NEW top-level
 * conversation — the long-conversation case, where a fresh context continues the work instead
 * of yet another compaction (a summary of a summary loses the beginning).
 */
async function openAndStart(
  input: SendMessageInput,
  win: BrowserWindow | undefined,
  title: string,
  brief: string,
  scope: Scope = 'subchat',
): Promise<string> {
  let child
  if (scope === 'chat') {
    child = await createContinuationRecord({ sourceId: input.sessionId, title, body: brief })
  } else {
    // The child hangs from the PERSON'S chat, never from the worker that is running
    // this turn: nested under a worker it shows up with the worker's icon, as if an
    // agent had opened it — when it is a conversation the user authorized.
    const parentId = input.parentSessionId ?? input.sessionId
    child = await createSubchatRecord({ parentId, title, body: brief })
  }
  if (!child) return 'Error: the current conversation could not be found, so nothing was opened.'
  if (win && scope === 'chat') pinModel(win, child.id, input.providerId, input.modelId)
  broadcastSessionEvent({ type: 'session', sessionId: child.id, session: child })
  if (win) startChildTurn(input, win, child, tNow('subchat.kickoff'))
  if (scope === 'chat') {
    return `New chat opened: "${child.title}" (#${child.id}). It is a top-level conversation in the same folder — not a subchat — starts from your brief and is already working on it in parallel. Tell the user where the work went.`
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

const SCOPE_INPUT = z
  .enum(['subchat', 'chat'])
  .default('subchat')
  .describe(
    'Where it goes. "subchat" (default) for a DIFFERENT subject: an attached conversation, nested under ' +
      'this one, that works in parallel. "chat" when the subject is THIS conversation being long ' +
      '(compactions stacking, the beginning of the work already lost): a NEW top-level conversation that ' +
      'continues the work with a fresh context — it does not become a child of this one.',
  )

export function createSubchatTools(input: SendMessageInput, win?: BrowserWindow): ToolSet {
  // Instructions of the same step to the same child: the second one refuses (see send_to_subchat).
  const inFlight = new Set<string>()

  return {
    suggest_subchat: tool({
      description: [
        'Proposes moving work that does not belong in this conversation to its own chat. Call it ON YOUR OWN',
        'INITIATIVE, without being asked, as soon as you notice any of these: a second task inside the',
        'request, a bug or a doubt the user mentioned in passing and that is not what you were asked to do,',
        'an investigation that would drag unrelated context in here, work for another project or another',
        'folder, or a conversation getting long enough that a fresh context is worth more than another',
        'compaction. The `scope` says WHERE it goes: a different subject is a subchat (attached to this',
        'one); when the subject is this conversation itself being long, it is a NEW chat (top-level,',
        'continuing the work with a fresh context — never a subchat of this one). One suggestion per',
        'subject — do not pile up cards. The user decides: open it (it starts working from your brief',
        'right away), do it here, or leave it aside; you never open a chat by yourself. Silence is the',
        'failure mode: if nothing was suggested in a long conversation, nothing was happening in it.',
      ].join(' '),
      inputSchema: z.object({ title: TITLE_INPUT, brief: BRIEF_INPUT, scope: SCOPE_INPUT }),
      execute: async ({ title, brief, scope: requestedScope }, { abortSignal }) => {
        // `subchat` is the concrete default, not only the schema's: a caller that does not
        // name the destination is suggesting a different subject, never a new top-level chat.
        const scope = requestedScope ?? 'subchat'
        if (!win) return 'Error: the suggestion needs the app window.'
        const requestId = newRequestId()
        let answer: string
        try {
          answer = await dispatchAsk<string>(
            input.sessionId,
            { requestId, kind: 'subchat', subchat: { title, brief, scope } },
            abortSignal,
          )
        } catch {
          // Turn aborted (stop) or app closed: nobody answered. It opens
          // nothing — the agent cannot decide in the person's place.
          return 'The suggestion was cancelled before the user answered — do not open a chat and leave that work aside.'
        } finally {
          // The card leaves the conversation as soon as the request ends — answer,
          // abort or error. Without this the answered card stayed on screen forever
          // (and came back when the chat was reopened).
          broadcastChatEvent({ type: 'ask:done', sessionId: input.sessionId, requestId })
        }
        if (answer === 'new') return openAndStart(input, win, title, brief, scope)
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
      execute: async ({ title, brief }) => openAndStart(input, win, title, brief),
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
        // It marks before firing: two parallel calls in the same step
        // would compete for the child's chat. It releases right away — the turn itself lives in the engine.
        inFlight.add(child.id)
        try {
          startChildTurn(input, win, child, tNow('subchat.fromParent') + message.trim())
        } finally {
          setTimeout(() => inFlight.delete(child.id), 1_000)
        }
        return `Instruction sent to "${child.title}" (#${child.id}). It is working on it in parallel — its result appears in the subchats list on your next turn, or read it with read_subchat.`
      },
    }),
  }
}
