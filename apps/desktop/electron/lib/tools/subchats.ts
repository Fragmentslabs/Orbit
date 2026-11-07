import type { BrowserWindow } from 'electron'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput, SessionInfo, SpecialistProfile } from '@shared/chat'
import { dispatchAsk } from '../ask-dispatch'
import { newRequestId } from '../ask-broker'
import { getRunningSessionIds, runChat } from '../chat-engine'
import { broadcastChatEvent } from '../broadcast'
import { broadcastSessionEvent } from '../companion-server'
import { createContinuationRecord, createSubchatRecord, findSubchat, readSubchatMessages } from '../subchats'
import { detachFromTurn } from '../session/write-journal'
import { tNow } from '../i18n'
import { wakeParentOf } from '../subchat-wake'

// The first message of the new chat (`subchat.kickoff`) is in the voice of whoever
// authorized the opening: the child starts working on its own, so the summary
// (the brief) is the context and that line only says to go ahead. The parent's
// later instructions carry `subchat.fromParent`, so in the child's chat they do
// not look like the user's. Both follow the app language (`electron/lib/i18n.ts`).

/**
 * Fires a turn in the child, in parallel to the parent's and without waiting for it — and,
 * when it ends, wakes the parent up with the result (subchat-wake.ts). The
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
  }))
    // A turn the parent started reports back: its final message wakes the parent up.
    .then(() => wakeParentOf(win, input, child))
    .catch((err) => console.error('[subchat] child turn failed:', err))
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
  profile?: SpecialistProfile,
): Promise<string> {
  let child
  if (scope === 'chat') {
    child = await createContinuationRecord({ sourceId: input.sessionId, title, body: brief })
  } else {
    // The child hangs from the PERSON'S chat, never from the worker that is running
    // this turn: nested under a worker it shows up with the worker's icon, as if an
    // agent had opened it — when it is a conversation the user authorized.
    const parentId = input.parentSessionId ?? input.sessionId
    child = await createSubchatRecord({ parentId, title, body: brief, profile })
  }
  if (!child) return 'Error: the current conversation could not be found, so nothing was opened.'
  if (win && scope === 'chat') pinModel(win, child.id, input.providerId, input.modelId)
  broadcastSessionEvent({ type: 'session', sessionId: child.id, session: child })
  if (win) startChildTurn(input, win, child, tNow('subchat.kickoff'))
  if (profile) {
    return `A ${profile} chat was opened for this: "${child.title}" (#${child.id}). It is a specialist chat attached to this conversation and is already working on it. Do NOT create the piece here — tell the user in one sentence that the work went to the ${profile} chat.`
  }
  if (scope === 'chat') {
    return `New chat opened: "${child.title}" (#${child.id}). It is a top-level conversation in the same folder — not a subchat — starts from your brief and is already working on it in parallel. Tell the user where the work went.`
  }
  return `Subchat opened: "${child.title}" (#${child.id}). It is attached to this conversation, starts from your brief and is already working on it in parallel. When it finishes, its final message comes back to you as a new turn — do not wait for it or poll it.`
}

/** Tool result when the user picks "do it in this conversation" — the task comes back with it. */
function doItHere(title: string, brief: string): string {
  return `The user chose to do it here. Do it now in this conversation, without opening a chat: ${title} — ${brief}`
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
    "The opening message of the new chat, in the user's language. Write it as if it were the only thing " +
      'the new chat knew — it has none of this conversation: the goal, what is already done and verified, ' +
      'what was decided and why, the files that matter with exact paths, and the next concrete step.',
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
        'Shows the user a card proposing to move work to its own chat, with your title and brief, and lets',
        'them choose: open it (it starts working from the brief right away, in the same folder), do it here,',
        'send it to a pipeline (when one exists) or leave it aside. Nothing opens unless they pick it — you never open a chat by yourself. Call it',
        'directly instead of announcing that you are separating the work: the card is the announcement.',
        'One card per subject — do not pile them up.',
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
        // Restates the task: after a long brief and a card, a small model answered "ok"
        // and lost track of what "it" was.
        if (answer === 'here') return doItHere(title, brief)
        if (answer.startsWith('pipeline:')) {
          const [, count, ...name] = answer.split(':')
          return `The user sent this work to the pipeline "${name.join(':')}" (${count} task(s) created, waiting for them to start). Do not do it here and do not open a chat: ${title}.`
        }
        return 'The user declined: do not open a chat and leave that work aside for now.'
      },
    }),

    open_subchat: tool({
      description: [
        'Opens a new chat attached to this one, in the same folder, and starts working in it immediately',
        'from the brief you write. Use it ONLY when the user explicitly asked for a new chat ("do this in a',
        'new chat", "open a chat for this") — then open it without asking. Otherwise use suggest_subchat and',
        'let them choose; never open a subchat on your own initiative.',
      ].join(' '),
      inputSchema: z.object({ title: TITLE_INPUT, brief: BRIEF_INPUT }),
      execute: async ({ title, brief }) => openAndStart(input, win, title, brief),
    }),

    read_subchat: tool({
      description: [
        'Reads a subchat you opened from this conversation (ids are in the subchats list of the turn): its',
        'most recent messages, oldest first, with tool calls shown by name. Use it to follow one when the',
        '"Latest" line in that list is not enough (what it found, where it stopped, whether it failed). Read-only.',
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
        'step) — never open another subchat for the same work. It does not wait for the reply: when the subchat finishes, its final message comes back to you as a new turn',
        '(marked as coming from the subchat), or read it with read_subchat. A subchat that is still running a turn is refused — wait or read it first.',
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
        return `Instruction sent to "${child.title}" (#${child.id}). It is working on it in parallel — when it finishes, its final message comes back to you as a new turn.`
      },
    }),
  }
}

/** Per (conversation, craft): the person already answered the offer, so it is not repeated. */
const offerDecided = new Set<string>()

const OFFERED: Array<{ tool: string; profile: SpecialistProfile; label: string }> = [
  { tool: 'fragment_create', profile: 'fragment', label: 'Fragment' },
  { tool: 'motion_write', profile: 'motion', label: 'Motion' },
  { tool: 'design_write', profile: 'design', label: 'Design' },
]

/**
 * The moment a general chat is about to CREATE a motion piece or a design canvas, the person
 * is offered a specialist chat for it (a lean agent of that craft, attached to this one).
 * It is detected here, at the gesture, so the general prompt carries no instruction about it.
 *
 * Once per conversation and craft: "continue here" (or declining) stands until the chat ends.
 * Specialist chats, workers and plan turns never see the offer.
 */
export function withSpecialistOffer(tools: ToolSet, input: SendMessageInput, win?: BrowserWindow): ToolSet {
  if (!win || input.options.profile || input.orchestrationRole === 'worker' || input.options.plan) return tools
  const wrapped: ToolSet = { ...tools }
  for (const { tool: name, profile, label } of OFFERED) {
    const original = tools[name]
    if (!original || typeof original.execute !== 'function') continue
    const run = original.execute.bind(original) as (args: unknown, options: unknown) => Promise<unknown>
    wrapped[name] = {
      ...original,
      execute: async (args: unknown, options: { abortSignal?: AbortSignal }) => {
        const key = `${input.sessionId}:${profile}`
        if (offerDecided.has(key)) return run(args, options)
        const piece = typeof (args as { name?: unknown })?.name === 'string' ? (args as { name: string }).name : ''
        const title = piece ? `${label}: ${piece}` : label
        const brief = (input.text ?? '').trim().slice(0, 1500) || title
        const requestId = newRequestId()
        let answer: string
        try {
          answer = await dispatchAsk<string>(
            input.sessionId,
            { requestId, kind: 'subchat', subchat: { title, brief, scope: 'subchat', profile } },
            options?.abortSignal,
          )
        } catch {
          return 'The offer was cancelled before the user answered — do not create anything and leave that work aside.'
        } finally {
          broadcastChatEvent({ type: 'ask:done', sessionId: input.sessionId, requestId })
        }
        offerDecided.add(key)
        if (answer === 'new') return openAndStart(input, win, title, brief, 'subchat', profile)
        if (answer === 'here') return run(args, options)
        return 'The user declined the specialist chat and does not want this created now: leave that work aside.'
      },
    } as ToolSet[string]
  }
  return wrapped
}
