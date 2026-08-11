import { tool } from 'ai'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { app } from 'electron'
import { capture } from '../snapshot'
import { errorToText } from '../errors'
import type { ToolContext } from './context'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 50 * 1024 * 1024

/**
 * Tool verify_changes: verificação pós-escrita do turno em andamento. O
 * snapshot inicial é capturado pelo chat-engine no início do turno e exposto
 * via ToolContext.getTurnSnapshot — aqui capturamos o estado ATUAL do
 * filesystem e diferecemos contra ele, devolvendo por arquivo o estado
 * (edited/created/removed) e o tamanho do diff (patchSize em caracteres).
 *
 * Sem snapshot (modo chat, captura falhou ou ainda não rodou) → changes vazio
 * com observação, para o modelo não inventar arquivos.
 */

// O repositório auxiliar de snapshots é o mesmo do engine em
// electron/lib/snapshot/index.ts (--git-dir em userData/snapshots/<hash> com
// --work-tree no projeto). Replicamos só o endereço — a manutenção do repo
// (ensureRepo/add/write-tree) continua centralizada no snapshot engine.
function gitDirFor(directory: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(directory)).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'snapshots', hash)
}

function git(directory: string, args: string[]): Promise<string> {
  return execFileAsync(
    'git',
    ['--git-dir', gitDirFor(directory), '--work-tree', directory, ...args],
    { cwd: directory, maxBuffer: MAX_BUFFER },
  ).then(({ stdout }) => stdout)
}

export function createVerifyChangesTool(ctx: ToolContext) {
  return tool({
    description:
      "Lists the files changed in the CURRENT turn (compared against the snapshot taken at turn start), each with state 'edited' | 'created' | 'removed' and patchSize (diff size in chars). Read-only. Call it before declaring completion after any edit/write/bash to confirm what was actually written; if it returns empty changes, nothing was persisted.",
    inputSchema: z.object({}),
    execute: async () => {
      const turn = ctx.getTurnSnapshot?.()
      if (!turn?.start) {
        return {
          changes: [],
          note: turn?.failed
            ? 'nenhuma alteração gravada (snapshot inicial do turno falhou: ' + (turn.error ?? 'motivo desconhecido') + ')'
            : 'nenhuma alteração gravada',
        }
      }
      try {
        const end = await capture(ctx.directory)
        if (end === turn.start) return { changes: [] }
        // --name-status dá o status por arquivo (A/M/D); o patch de cada
        // arquivo é medido separadamente para o patchSize individual.
        const statusLines = (await git(ctx.directory, ['diff', '--name-status', turn.start, end]))
          .split('\n')
          .filter(Boolean)
        if (statusLines.length === 0) return { changes: [] }

        const changes: { path: string; state: 'edited' | 'created' | 'removed'; patchSize: number }[] = []
        for (const line of statusLines) {
          const parts = line.split('\t')
          // Rename/copy reportam dois caminhos (origem\t destino) — usamos o último
          const file = parts[parts.length - 1]
          if (!file) continue
          const status = parts[0]
          const state = status === 'A' ? 'created' : status === 'D' ? 'removed' : 'edited'
          let patchSize = 0
          try {
            patchSize = (await git(ctx.directory, ['diff', turn.start, end, '--', file])).length
          } catch {
            // patchSize é informativo — não derruba a verificação
          }
          changes.push({ path: file, state, patchSize })
        }
        return { changes }
      } catch (err) {
        return { changes: [], note: `erro ao verificar alterações: ${errorToText(err)}` }
      }
    },
  })
}
