import path from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { BASE_REMOTE, type WorktreeInfo } from '@shared/worktrees'
import { broadcastChatEvent } from '../broadcast'
import { readJson, writeJson } from '../storage'
import { createChatWorktree, listWorktrees, removeChatWorktree } from '../worktrees/service'
import type { ToolContext } from './context'

/**
 * Worktrees through the agent: "do this in a separate worktree", "go back to
 * the main one". The same service as the header selector — the UI is the main
 * path; this is the shortcut in the middle of the conversation.
 *
 * Switching the folder counts from the NEXT message: this turn's tools, the
 * revert snapshot and the diff are already bound to the old folder. Changing
 * in the middle would leave the turn's revert pointing at the wrong place.
 */

function describe(w: WorktreeInfo, current: string): string {
  const state = [
    w.primary ? 'main checkout' : `origin: ${w.origin}`,
    w.branch ? `branch ${w.branch}` : `detached at ${w.head}`,
    w.changes > 0 ? `${w.changes} uncommitted file(s)` : 'clean',
    w.ahead > 0 ? `${w.ahead} commit(s) ahead of the main checkout's branch` : null,
    w.available ? null : 'FOLDER MISSING',
    path.resolve(w.path) === path.resolve(current) ? 'CURRENT — this chat works here' : null,
  ].filter(Boolean)
  return `- ${w.primary ? 'main' : w.name}: ${w.path} (${state.join(', ')})`
}

/** Matches what the model asked with a worktree: "principal", name, branch or path. */
function findWorktree(worktrees: WorktreeInfo[], query: string): WorktreeInfo | undefined {
  const target = query.trim()
  if (/^(principal|main|main checkout)$/i.test(target)) return worktrees.find((w) => w.primary)
  return (
    worktrees.find((w) => path.resolve(w.path) === path.resolve(target)) ??
    worktrees.find((w) => w.name === target) ??
    worktrees.find((w) => w.branch === target || w.branch === `orbit/${target}`)
  )
}

/** Switches the session's main folder (the renderer follows through the "session" event). */
async function switchFolder(sessionId: string, folder: string): Promise<void> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) throw new Error('Session not found.')
  const next: SessionInfo = { ...session, directory: folder, updatedAt: Date.now() }
  await writeJson(StorageKeys.session(sessionId), next)
  broadcastChatEvent({ type: 'session', sessionId, session: next })
}

const SWITCH_NOTICE =
  'The switch applies from the NEXT message: the tools of this turn still point to the previous folder. ' +
  'Do not edit files now — end your reply telling the user the chat moved, and continue the work in the next turn.'

export function createWorktreeTools(ctx: ToolContext): ToolSet {
  return {
    worktree_list: tool({
      description:
        'Lists the git worktrees of the repository this chat works in: the main checkout, worktrees created by Orbit chats, by pipeline tasks and by the user outside Orbit, with branch and status. Marks the one this chat is in.',
      inputSchema: z.object({}),
      execute: async () => {
        const list = await listWorktrees(ctx.directory)
        if (!list) return 'This chat folder is not inside a git repository — worktrees are not available.'
        return [`Repository: ${list.repo}`, ...list.worktrees.map((w) => describe(w, list.current))].join('\n')
      },
    }),

    worktree_create: tool({
      description: [
        'Creates a git worktree for this repository: a separate working copy on its own branch (orbit/<name>), so work here does not touch the main checkout or other chats.',
        'Use it when the user asks to work isolated, try something disposable, or run in parallel with other work.',
        'node_modules are cloned and .env files copied (this can take a few seconds).',
        'By default the chat switches to it — from the next message on.',
      ].join(' '),
      inputSchema: z.object({
        name: z.string().describe('Short name, becomes the folder and the branch orbit/<name> (e.g. "login-refactor")'),
        base: z
          .string()
          .optional()
          .describe(
            `Branch or commit to start from. Default: the main checkout's current branch. "${BASE_REMOTE}" = the remote's default branch (origin/main) after a fetch, without unpushed local commits.`,
          ),
        switchChat: z.boolean().optional().describe('Switch this chat to the new worktree (default true)'),
      }),
      execute: async ({ name, base, switchChat }) => {
        const created = await createChatWorktree({ folder: ctx.directory, name, base, signal: ctx.abort })
        const lines = [
          `Worktree created: ${created.path}`,
          `branch ${created.branch}, from ${created.base}`,
          created.dependencies === 'linked'
            ? 'node_modules are LINKED to the main checkout: do not run install commands there.'
            : created.dependencies === 'cloned'
              ? 'node_modules cloned from the main checkout.'
              : 'No node_modules in the repository.',
        ]
        if (switchChat !== false) {
          await switchFolder(ctx.sessionId, created.folder)
          lines.push(`This chat now works in ${created.folder}.`, SWITCH_NOTICE)
        }
        return lines.join('\n')
      },
    }),

    worktree_switch: tool({
      description:
        'Switches the folder this chat works in to another worktree of the same repository (or back to the main checkout with "main"). Applies from the next message.',
      inputSchema: z.object({
        target: z.string().describe('"main", a worktree name, its branch, or its path (see worktree_list)'),
      }),
      execute: async ({ target: query }) => {
        const list = await listWorktrees(ctx.directory)
        if (!list) return 'This chat folder is not inside a git repository.'
        const target = findWorktree(list.worktrees, query)
        if (!target) return `No worktree matches "${query}". Available:\n${list.worktrees.map((w) => describe(w, list.current)).join('\n')}`
        if (!target.available) return `The folder of "${target.name}" no longer exists — it cannot be used.`
        if (path.resolve(target.path) === path.resolve(list.current)) return `This chat already works in ${target.path}.`
        await switchFolder(ctx.sessionId, target.folder)
        return `This chat now works in ${target.folder} (${target.branch ? `branch ${target.branch}` : 'detached'}).\n${SWITCH_NOTICE}`
      },
    }),

    worktree_remove: tool({
      description: [
        'Removes a worktree: deletes its folder (uncommitted changes there are LOST) and stops background processes running in it.',
        'The branch is kept unless deleteBranch is true. Cannot remove the main checkout, pipeline-task worktrees, or the one this chat is in (switch away first).',
        'Always asks the user for confirmation.',
      ].join(' '),
      inputSchema: z.object({
        target: z.string().describe('Worktree name, branch or path (see worktree_list)'),
        deleteBranch: z.boolean().optional().describe('Also delete its branch (default false — committed work stays reachable)'),
      }),
      execute: async ({ target: query, deleteBranch }) => {
        const list = await listWorktrees(ctx.directory)
        if (!list) return 'This chat folder is not inside a git repository.'
        const target = findWorktree(list.worktrees, query)
        if (!target) return `No worktree matches "${query}".`
        if (path.resolve(target.path) === path.resolve(list.current)) {
          return 'This chat is working in that worktree. Switch to another one first (worktree_switch), then remove it in the next turn.'
        }
        await removeChatWorktree({ folder: ctx.directory, path: target.path, deleteBranch })
        return `Worktree removed: ${target.path}${deleteBranch && target.branch ? ` (branch ${target.branch} deleted)` : target.branch ? ` (branch ${target.branch} kept)` : ''}.`
      },
    }),
  }
}
