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
 * Truncates the list from the turn that contains `messageId`, returning
 * [truncated, discarded].
 *
 * The revert is triggered by the USER message: it cuts at that message itself, discarding
 * it and everything that came after. An assistant message id is still accepted
 * (its counterpart on an older version) and cuts at the user+answer pair — but only when the
 * previous one really is from the user, otherwise two user messages in a row (a send
 * that failed, the queue) would make the cut swallow the previous turn.
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

  // The folder is the workspace: the lock stops a turn of ANOTHER conversation in the
  // same folder from writing between reading the messages and the S/E/C transition.
  // With no folder (chat mode), there are only messages and media.
  const work = async (): Promise<SessionRevert | null> => {
    const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
    const targetIdx = messages.findIndex((m) => m.id === messageId)
    if (targetIdx < 0) return null

    // Both modes truncate the messages immediately
    const [truncated, discarded] = truncateAt(messages, messageId)
    if (discarded.length === 0) return null

    await writeJson(StorageKeys.messages(sessionId), truncated)
    broadcastChatEvent({ type: 'messages', sessionId, messages: truncated })

    const revertState: SessionRevert = session.directory
      ? await revertFiles(session.directory, messageId, discarded)
      : // Chat mode: the conversation has no working folder
        { messageId, discardedMessages: discarded }

    // Media (pieces and gallery): in BOTH modes — it lives in the app storage,
    // which the working folder snapshot does not reach. Undoes what the discarded
    // turns produced, from the first to the last.
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
 * The discarded turns that touched the folder, from the LAST to the first — the
 * order in which they have to be undone: turn 2 goes back to its own start (which is
 * the end of turn 1), and only then does turn 1 go back to its start. Undoing only the
 * first one left out what the second created, and a file both of them edited became a
 * false conflict.
 *
 * The paths of confirmed authorship are the ones the tools of the turn wrote
 * (`snapshot.authored`); the ones another conversation wrote in the interval
 * (`snapshot.others`) stay out; the rest of the diff is of uncertain authorship (bash,
 * MCP, something external). A turn from before the journal (no `authored`): the whole diff
 * counts as its own, as before.
 */
async function fileTurnsOf(directory: string, discarded: ChatMessage[]): Promise<FileTurns> {
  const withSnapshot = discarded.filter((m) => m.role === 'assistant' && m.snapshot)
  if (withSnapshot.length === 0) return { reason: 'no-snapshot' }
  const turns: RevertFileTurn[] = []
  for (const message of [...withSnapshot].reverse()) {
    const snapshot = message.snapshot!
    const { start, end } = snapshot
    // Without `start` there is no state to go back to.
    if (!start) return { reason: 'no-snapshot' }
    // Turn without writes: nothing to undo, and the folder is not touched. With `end`,
    // the folder changed through a manual save or another conversation: the transition runs and
    // separates what belongs to the turn.
    if (snapshot.verified === 'unchanged' && !end) continue
    // The turn may have written, but the final state was not recorded (capture
    // failed, crash). Without E there is no way to tell the turn's write from someone
    // else's — restoring would be guessing.
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

/** Applies the turns in order (from the last to the first) with the S/E/C rule. */
async function applyTurns(directory: string, turns: RevertFileTurn[], withUncertain: boolean): Promise<AppliedTurns> {
  const applied = new Set<string>()
  const conflicts = new Set<string>()
  for (const turn of turns) {
    const paths = withUncertain ? [...turn.paths, ...turn.uncertain] : turn.paths
    if (paths.length === 0) continue
    // Manual saves from the panel during the turn are not the agent's work: they come in
    // as a conflict (preserved), never as reverted.
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

/** Post-revert state and the diff of what was undone. With nothing applied, the post is the pre. */
async function afterAndDiff(
  directory: string,
  current: string,
  applied: string[],
): Promise<{ after?: string; diff: string }> {
  if (applied.length === 0) return { after: current, diff: '' }
  const after = await capture(directory).catch((err) => {
    console.error('[revert] post-revert state capture failed (unrevert will have no files):', err)
    return undefined
  })
  // From after to before the revert: that is what the turns had done to these paths.
  const changes = after
    ? await diffPaths(directory, after, current, applied).catch(() => ({ files: applied, patch: '' }))
    : { files: applied, patch: '' }
  return { after, diff: changes.patch }
}

/**
 * Code mode: undoes ONLY the paths the discarded turns changed and
 * that their tools wrote, comparing the current state (C) with the end (E) and
 * the start (S) of each turn.
 *
 * - C == E: the path is still what the turn left → it goes back to S;
 * - C == S: it is already undone → do nothing;
 * - anything else: someone touched it afterwards (another conversation in the same folder, the
 *   user outside Orbit) → preserve it and report a conflict.
 *
 * The paths of uncertain authorship stay as they are and go to `uncertain`.
 *
 * The truncation was already persisted by the caller — if the restore fails, the
 * exception must NOT bubble up: the messages would stay cut with no revert bar
 * and no unrevert. Returns filesRestored:false with the reason for the UI to warn.
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

    // State immediately before the revert — it is what the unrevert gives back. Without
    // it, NOTHING is touched: applying the transition anyway would leave files
    // undone with no way back (and the unrevert, without `snapshot`, would not
    // warn). The failure goes up to the catch below → 'capture-failed'.
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
    console.error('[revert] failed to restore the filesystem (truncation already saved):', err)
    return { messageId, filesRestored: false, reason: 'capture-failed', discardedMessages: discarded }
  }
}

/**
 * "Revert also" the paths of uncertain authorship of the active revert. It redoes the
 * whole chain of turns with them included: what was already undone comes back
 * as "already there" (nothing to do), and a path of confirmed authorship that had
 * conflicted because of an uncertain one (the bash of the next turn touched it)
 * can now go back too. The same S/E/C rule holds: what changed after the
 * turn stays preserved.
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
      console.error('[revert] revert of the uncertain paths failed:', err)
      return state
    }
  })
}

export async function unrevert(sessionId: string): Promise<UnrevertResult> {
  const before = await loadSession(sessionId)
  if (!before?.revert) return { done: false }

  const work = async (): Promise<UnrevertResult> => {
    // Re-reads UNDER the lock: a turn that got in first may have consolidated the
    // revert (cleanupRevert) — then there is nothing left to undo, and using the state
    // read before the queue would resurrect messages that were already discarded.
    const session = await loadSession(sessionId)
    if (!session?.revert) return { done: false }
    const revertState = session.revert

    // Restores the discarded messages (both modes)
    if (revertState.discardedMessages) {
      const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
      const restored = [...messages, ...revertState.discardedMessages]
      await writeJson(StorageKeys.messages(sessionId), restored)
      broadcastChatEvent({ type: 'messages', sessionId, messages: restored })
    }

    // Code mode: gives the files back with the SAME conflict rule. `after`
    // is the state the revert left; if something changed since then, the
    // path is preserved.
    let files: UnrevertResult['files']
    if (session.directory && revertState.snapshot) {
      try {
        if (revertState.after) {
          const result = await transition(session.directory, revertState.after, revertState.snapshot)
          files = { restored: result.applied.length, conflicts: result.conflicts }
        } else {
          // Without the post-revert state there is no way to know what changed after it.
          files = { restored: 0, conflicts: [], error: 'no-after' }
        }
      } catch (err) {
        // The messages are already back; the files stay as they are and the failure
        // becomes a visible conflict instead of a rejected promise.
        console.error('[revert] unrevert of the files failed:', err)
        files = { restored: 0, conflicts: [], error: 'failed' }
      }
    }

    // Media: the redo stored by the revert (in both modes), with the same rule.
    const media = await unrevertMedia(sessionId)

    const next = { ...session }
    delete next.revert
    await saveSession(next)
    return { done: true, files, media }
  }

  return before.directory ? withWorkspaceLock(before.directory, work) : work()
}

/**
 * Called when sending a new message with an active revert: if the messages were not
 * truncated yet (e.g. the revert was saved but something failed), truncate them now.
 * Removes the revert state from the session.
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
  // The discarded turns do not come back anymore: their media journals and the redo
  // stop being useful.
  await discardMediaRevert(sessionId, assistantIdsOf(session.revert.discardedMessages ?? []))

  const next = { ...session }
  delete next.revert
  await saveSession(next)
  return truncated
}
