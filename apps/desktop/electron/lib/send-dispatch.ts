import type { BrowserWindow } from 'electron'
import type { SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { rejectSession as rejectSessionAsks } from './ask-broker'
import { abortChat, runChat, startSessionNaming } from './chat-engine'
import { abortLoop, runChatWithLoop } from './loop-engine'
import { abortOrchestration, runOrchestration } from './orchestrator'
import { clearSessionTrust } from './permission'
import { readJson } from './storage'

/**
 * Routing of a send to the right engine, and the shutdown of a session.
 *
 * This used to live inside `ipcMain.handle('chat:send')`, so it applied only to
 * sends made ON the desktop: the companion's `messages:send` called `runChat`
 * directly and its `chat:abort` stopped half of the things. In practice, from the
 * phone the orchestration mode ran as a plain chat, the loop ran a single turn, and
 * stopping the run left the loop spinning and the requests hanging.
 *
 * The engines do not decide any of this on their own (`runChat` does not even
 * read `options.orchestrate`), so the routing has to be a single one for both
 * paths — that is what this module is.
 */

const LOOP_DEFAULT = { maxIterations: 5 }

/**
 * The last send of each conversation. The answer typed in the Computer
 * Use panels goes out with the SAME options (computer mode, permissions, reasoning) —
 * rebuilding them outside the main window's input would turn the control off in
 * the middle of the task.
 */
const lastInputs = new Map<string, SendMessageInput>()

export function lastSendInput(sessionId: string): SendMessageInput | null {
  return lastInputs.get(sessionId) ?? null
}

/** Applies the mode's rules and hands it to the corresponding engine. */
export async function dispatchSend(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  lastInputs.set(input.sessionId, input)
  // Golden rule: workers do not orchestrate (no infinite recursion).
  // Workers may use subagents (depth limit managed by the subagent tool).
  const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
  if (session?.orchestration?.role === 'worker') {
    input = { ...input, options: { ...input.options, orchestrate: undefined } }
  }
  // Name the chat HERE, before the routing: it is the only point every origin
  // goes through (desktop, companion, Orchestra, Loop) and it runs before the
  // attachment preprocessing, which can take tens of seconds. The title used to
  // be born at the end of the turn — and the Orchestra path (runOrchestration
  // does not go through runChatTurn) never named anything.
  await startSessionNaming(win, input, session)
  // Retry redoes ONE turn, it does not open a new one: orchestration and loop
  // create turns on their own (and do not know `retryOf`), so a retry always runs
  // on the simple engine — the same one that produced the reply that failed.
  if (input.retryOf) {
    void runChat(win, input)
    return
  }
  // Orchestration is exclusive to code mode
  if (input.options.orchestrate && input.mode !== 'code') {
    input = { ...input, options: { ...input.options, orchestrate: undefined } }
  }
  // Orchestration: turns plan off (incompatible) and the Loop — in the orchestra
  // the reviewer is the orchestrator, with the budget from the Orchestra settings
  // ("Adjustments per worker"). The Loop used to be turned on here and its
  // iterations silently became the review budget. Subagents by default.
  if (input.options.orchestrate) {
    input = {
      ...input,
      options: {
        ...input.options,
        plan: undefined,
        loop: undefined,
        subagents: input.options.subagents !== false,
      },
      loopConfig: undefined,
    }
    void runOrchestration(win, input)
    return
  }
  if (input.options.loop) {
    void runChatWithLoop(win, input, input.loopConfig ?? LOOP_DEFAULT)
    return
  }
  void runChat(win, input)
}

/** Stops everything the session has in progress — engines, pending requests and the
 *  trust granted in the turn. Stopping halfway left the loop spinning. */
export function abortSession(sessionId: string): void {
  abortChat(sessionId)
  abortLoop(sessionId)
  abortOrchestration(sessionId)
  rejectSessionAsks(sessionId)
  clearSessionTrust(sessionId)
}
