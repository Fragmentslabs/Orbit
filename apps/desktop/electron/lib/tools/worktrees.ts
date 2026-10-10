import path from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { BASE_REMOTO, type WorktreeInfo } from '@shared/worktrees'
import { broadcastChatEvent } from '../broadcast'
import { readJson, writeJson } from '../storage'
import { criarWorktreeDoChat, listarWorktrees, removerWorktreeDoChat } from '../worktrees/servico'
import type { ToolContext } from './context'

/**
 * Worktrees pelo agente: "faz isso num worktree separado", "volta para o
 * principal". O mesmo serviço do seletor do header — a UI é o caminho
 * principal; isto é o atalho no meio da conversa.
 *
 * Trocar a pasta vale a partir da PRÓXIMA mensagem: as ferramentas deste
 * turno, o snapshot de revert e o diff já estão presos à pasta antiga. Mudar
 * no meio deixaria o revert do turno apontando para o lugar errado.
 */

function descrever(w: WorktreeInfo, atual: string): string {
  const estado = [
    w.principal ? 'main checkout' : `origin: ${w.origem}`,
    w.branch ? `branch ${w.branch}` : `detached at ${w.head}`,
    w.alteracoes > 0 ? `${w.alteracoes} uncommitted file(s)` : 'clean',
    w.aFrente > 0 ? `${w.aFrente} commit(s) ahead of the main checkout's branch` : null,
    w.disponivel ? null : 'FOLDER MISSING',
    path.resolve(w.caminho) === path.resolve(atual) ? 'CURRENT — this chat works here' : null,
  ].filter(Boolean)
  return `- ${w.principal ? 'principal' : w.nome}: ${w.caminho} (${estado.join(', ')})`
}

/** Casa o que o modelo pediu com um worktree: "principal", nome, branch ou caminho. */
function encontrar(worktrees: WorktreeInfo[], destino: string): WorktreeInfo | undefined {
  const alvo = destino.trim()
  if (/^(principal|main|main checkout)$/i.test(alvo)) return worktrees.find((w) => w.principal)
  return (
    worktrees.find((w) => path.resolve(w.caminho) === path.resolve(alvo)) ??
    worktrees.find((w) => w.nome === alvo) ??
    worktrees.find((w) => w.branch === alvo || w.branch === `orbit/${alvo}`)
  )
}

/** Troca a pasta principal da sessão (o renderer acompanha pelo evento "session"). */
async function trocarPasta(sessionId: string, pasta: string): Promise<void> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) throw new Error('Sessão não encontrada.')
  const next: SessionInfo = { ...session, directory: pasta, updatedAt: Date.now() }
  await writeJson(StorageKeys.session(sessionId), next)
  broadcastChatEvent({ type: 'session', sessionId, session: next })
}

const AVISO_TROCA =
  'The switch applies from the NEXT message: the tools of this turn still point to the previous folder. ' +
  'Do not edit files now — end your reply telling the user the chat moved, and continue the work in the next turn.'

export function createWorktreeTools(ctx: ToolContext): ToolSet {
  return {
    worktree_list: tool({
      description:
        'Lists the git worktrees of the repository this chat works in: the main checkout, worktrees created by Orbit chats, by pipeline tasks and by the user outside Orbit, with branch and status. Marks the one this chat is in.',
      inputSchema: z.object({}),
      execute: async () => {
        const lista = await listarWorktrees(ctx.directory)
        if (!lista) return 'This chat folder is not inside a git repository — worktrees are not available.'
        return [`Repository: ${lista.repo}`, ...lista.worktrees.map((w) => descrever(w, lista.atual))].join('\n')
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
        nome: z.string().describe('Short name, becomes the folder and the branch orbit/<name> (e.g. "login-refactor")'),
        base: z
          .string()
          .optional()
          .describe(
            `Branch or commit to start from. Default: the main checkout's current branch. "${BASE_REMOTO}" = the remote's default branch (origin/main) after a fetch, without unpushed local commits.`,
          ),
        trocar: z.boolean().optional().describe('Switch this chat to the new worktree (default true)'),
      }),
      execute: async ({ nome, base, trocar }) => {
        const criado = await criarWorktreeDoChat({ pasta: ctx.directory, nome, base, signal: ctx.abort })
        const linhas = [
          `Worktree created: ${criado.caminho}`,
          `branch ${criado.branch}, from ${criado.base}`,
          criado.dependencias === 'vinculadas'
            ? 'node_modules are LINKED to the main checkout: do not run install commands there.'
            : criado.dependencias === 'clonadas'
              ? 'node_modules cloned from the main checkout.'
              : 'No node_modules in the repository.',
        ]
        if (trocar !== false) {
          await trocarPasta(ctx.sessionId, criado.pasta)
          linhas.push(`This chat now works in ${criado.pasta}.`, AVISO_TROCA)
        }
        return linhas.join('\n')
      },
    }),

    worktree_switch: tool({
      description:
        'Switches the folder this chat works in to another worktree of the same repository (or back to the main checkout with "principal"). Applies from the next message.',
      inputSchema: z.object({
        destino: z.string().describe('"principal", a worktree name, its branch, or its path (see worktree_list)'),
      }),
      execute: async ({ destino }) => {
        const lista = await listarWorktrees(ctx.directory)
        if (!lista) return 'This chat folder is not inside a git repository.'
        const alvo = encontrar(lista.worktrees, destino)
        if (!alvo) return `No worktree matches "${destino}". Available:\n${lista.worktrees.map((w) => descrever(w, lista.atual)).join('\n')}`
        if (!alvo.disponivel) return `The folder of "${alvo.nome}" no longer exists — it cannot be used.`
        if (path.resolve(alvo.caminho) === path.resolve(lista.atual)) return `This chat already works in ${alvo.caminho}.`
        await trocarPasta(ctx.sessionId, alvo.pasta)
        return `This chat now works in ${alvo.pasta} (${alvo.branch ? `branch ${alvo.branch}` : 'detached'}).\n${AVISO_TROCA}`
      },
    }),

    worktree_remove: tool({
      description: [
        'Removes a worktree: deletes its folder (uncommitted changes there are LOST) and stops background processes running in it.',
        'The branch is kept unless apagarBranch is true. Cannot remove the main checkout, pipeline-task worktrees, or the one this chat is in (switch away first).',
        'Always asks the user for confirmation.',
      ].join(' '),
      inputSchema: z.object({
        destino: z.string().describe('Worktree name, branch or path (see worktree_list)'),
        apagarBranch: z.boolean().optional().describe('Also delete its branch (default false — committed work stays reachable)'),
      }),
      execute: async ({ destino, apagarBranch }) => {
        const lista = await listarWorktrees(ctx.directory)
        if (!lista) return 'This chat folder is not inside a git repository.'
        const alvo = encontrar(lista.worktrees, destino)
        if (!alvo) return `No worktree matches "${destino}".`
        if (path.resolve(alvo.caminho) === path.resolve(lista.atual)) {
          return 'This chat is working in that worktree. Switch to another one first (worktree_switch), then remove it in the next turn.'
        }
        await removerWorktreeDoChat({ pasta: ctx.directory, caminho: alvo.caminho, apagarBranch })
        return `Worktree removed: ${alvo.caminho}${apagarBranch && alvo.branch ? ` (branch ${alvo.branch} deleted)` : alvo.branch ? ` (branch ${alvo.branch} kept)` : ''}.`
      },
    }),
  }
}
