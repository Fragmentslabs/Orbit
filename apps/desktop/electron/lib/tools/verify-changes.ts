import { tool } from 'ai'
import { z } from 'zod'
import { capture, snapshotGit } from '../snapshot'
import { errorToText } from '../errors'
import type { ToolContext } from './context'

export interface VerifyChangesResult {
  changes: { path: string; state: 'edited' | 'created' | 'removed'; patchSize: number }[]
  note?: string
}

/**
 * Núcleo da verificação pós-escrita do turno em andamento. O snapshot
 * inicial é capturado pelo chat-engine no início do turno e exposto via
 * ToolContext.getTurnSnapshot — aqui capturamos o estado ATUAL do
 * filesystem e diferecemos contra ele, devolvendo por arquivo o estado
 * (edited/created/removed) e o tamanho do diff (patchSize em caracteres).
 *
 * Compartilhado entre a tool (createVerifyChangesTool, chamada pelo modelo)
 * e o chat-engine, que a executa deterministicamente no fim do turno quando
 * o modelo conclui sem verificar (anti-overclaim) — o modelo não pode
 * "pular" a verificação se o engine a roda por conta própria.
 *
 * Sem snapshot (modo chat, captura falhou ou ainda não rodou) → changes vazio
 * com observação, para o modelo não inventar arquivos.
 *
 * A invocação do git é a MESMA do engine de snapshots (--git-dir em
 * userData/snapshots/<hash> com --work-tree no projeto, binário e PATH
 * resolvidos no load — snapshotGit em electron/lib/snapshot/index.ts): fonte
 * única, sem duplicar gitDirFor nem a resolução do binário (B3).
 */
export async function verifyTurnChanges(ctx: ToolContext): Promise<VerifyChangesResult> {
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
    const statusLines = (await snapshotGit(ctx.directory, ['diff', '--name-status', turn.start, end]))
      .split('\n')
      .filter(Boolean)
    if (statusLines.length === 0) return { changes: [] }

    const changes: VerifyChangesResult['changes'] = []
    for (const line of statusLines) {
      const parts = line.split('\t')
      // Rename/copy reportam dois caminhos (origem\t destino) — usamos o último
      const file = parts[parts.length - 1]
      if (!file) continue
      const status = parts[0]
      const state = status === 'A' ? 'created' : status === 'D' ? 'removed' : 'edited'
      let patchSize = 0
      try {
        patchSize = (await snapshotGit(ctx.directory, ['diff', turn.start, end, '--', file])).length
      } catch {
        // patchSize é informativo — não derruba a verificação
      }
      changes.push({ path: file, state, patchSize })
    }
    return { changes }
  } catch (err) {
    return { changes: [], note: `erro ao verificar alterações: ${errorToText(err)}` }
  }
}

export function createVerifyChangesTool(ctx: ToolContext) {
  return tool({
    description:
      "Lists the files changed in the CURRENT turn (compared against the snapshot taken at turn start), each with state 'edited' | 'created' | 'removed' and patchSize (diff size in chars). Read-only. Call it before declaring completion after any edit/write/bash to confirm what was actually written; if it returns empty changes, nothing was persisted.",
    inputSchema: z.object({}),
    execute: async () => verifyTurnChanges(ctx),
  })
}
