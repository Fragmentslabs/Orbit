import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { StorageKeys, type FolderInfo, type SessionInfo } from '@shared/chat'
import { setArchivedState } from '@shared/archive'
import { listKeys, readJson, removeJson, writeJson } from '../storage'
import { broadcastSessionEvent } from '../companion-server'
import { abortChat } from '../chat-engine'
import { deleteMediaJournals } from '../session/media-journal'

/**
 * Chat maintenance by the agent — the basis of the cleanup routines.
 *
 * Archiving is reversible and is the default path; deleting erases messages and the
 * revert history, so it has its own rules (see chat_delete).
 *
 * The sessions are mutated here in main and the renderer follows through the
 * "session" / "session:deleted" / "folders" events, which it already handles.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** How many chats a single delete call can erase. */
const DELETE_LIMIT = 25

async function loadSessions(): Promise<SessionInfo[]> {
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const items = await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))
  return items.filter((s): s is SessionInfo => s != null)
}

async function loadFolders(): Promise<FolderInfo[]> {
  return (await readJson<FolderInfo[]>(StorageKeys.folders)) ?? []
}

function daysInactive(session: SessionInfo, now: number): number {
  return Math.floor((now - session.updatedAt) / DAY_MS)
}

function describeSession(session: SessionInfo, folders: Map<string, string>, now: number): string {
  const folder = session.folderId ? folders.get(session.folderId) : undefined
  const marks = [
    session.pinned ? 'pinned' : null,
    session.archived ? 'archived' : null,
    folder ? `folder: ${folder}` : null,
    session.directory ? `dir: ${session.directory}` : null,
  ].filter(Boolean)
  const extra = marks.length ? ` (${marks.join(', ')})` : ''
  return `#${session.id} [${session.mode}] ${daysInactive(session, now)}d without interaction — "${session.title}"${extra}`
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
        const now = Date.now()
        const [sessoes, folders] = await Promise.all([loadSessions(), loadFolders()])
        const nameById = new Map(folders.map((f) => [f.id, f.name]))
        const folderIds = folder
          ? new Set(folders.filter((f) => f.name === folder).map((f) => f.id))
          : null

        const filtered = sessoes
          .filter((s) => {
            if (mode && s.mode !== mode) return false
            if (!includePinned && s.pinned) return false
            if (!includeArchived && s.archived) return false
            // Orchestration workers and routine executions are not the
            // user's chats: they belong to another session or to the routine
            // that created them.
            if (s.parentId || s.routineId) return false
            if (folderIds && (!s.folderId || !folderIds.has(s.folderId))) return false
            if (inactiveDays != null && daysInactive(s, now) < inactiveDays) return false
            return true
          })
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, limit ?? 50)

        if (filtered.length === 0) return 'No chat matches these criteria.'
        return [
          `${filtered.length} chat(s), oldest to newest:`,
          ...filtered.map((s) => describeSession(s, nameById, now)),
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
        const target = archived ?? true
        const results: string[] = []
        let updated = 0
        for (const id of ids) {
          const session = await readJson<SessionInfo>(StorageKeys.session(id))
          if (!session) {
            results.push(`#${id}: not found`)
            continue
          }
          if (session.pinned && target) {
            results.push(`#${id}: pinned by the user — not archived`)
            continue
          }
          if (session.archived === target) continue
          const next = setArchivedState(session, target)
          await writeJson(StorageKeys.session(id), next)
          broadcastSessionEvent({ type: 'session', sessionId: id, session: next })
          updated++
        }
        const verb = target ? 'archived' : 'unarchived'
        return [`${updated} chat(s) ${verb}.`, ...results].join('\n')
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
        reason: z
          .string()
          .min(10)
          .describe(
            'Why deleting (not archiving) is right for THESE chats. Written out so the decision is deliberate and auditable.',
          ),
      }),
      execute: async ({ ids, reason }) => {
        if (ids.length > DELETE_LIMIT) {
          return `Error: ${ids.length} chats in a single call exceeds the limit of ${DELETE_LIMIT}. Deletion is irreversible — review the list and do it in smaller batches.`
        }
        const results: string[] = []
        let deleted = 0
        for (const id of ids) {
          const session = await readJson<SessionInfo>(StorageKeys.session(id))
          if (!session) {
            results.push(`#${id}: not found`)
            continue
          }
          if (session.pinned) {
            results.push(`#${id}: pinned by the user — not deleted`)
            continue
          }
          // It stops whatever is running before deleting: an orphan stream
          // would keep writing to a session that no longer exists.
          abortChat(id)
          await removeJson(StorageKeys.session(id))
          await removeJson(StorageKeys.messages(id))
          await deleteMediaJournals(id).catch(() => {})
          await removeJson(StorageKeys.planReview(id))
          await removeJson(StorageKeys.pendingAsks(id))
          broadcastSessionEvent({ type: 'session:deleted', sessionId: id })
          deleted++
        }
        return [`${deleted} chat(s) permanently deleted. Reason: ${reason}`, ...results].join('\n')
      },
    }),
  }
}
