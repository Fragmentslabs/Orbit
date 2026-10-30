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
 * Core of the post-write check of the turn in progress. The initial
 * snapshot is captured by the chat-engine at the start of the turn and exposed via
 * ToolContext.getTurnSnapshot — here we capture the CURRENT state of the
 * filesystem and diff against it, returning per file the state
 * (edited/created/removed) and the diff size (patchSize in characters).
 *
 * Shared between the tool (createVerifyChangesTool, called by the model)
 * and the chat-engine, which runs it deterministically at the end of the turn when
 * the model finishes without checking (anti-overclaim) — the model cannot
 * "skip" the check if the engine runs it on its own.
 *
 * With no snapshot (chat mode, capture failed or has not run yet) → empty changes
 * with a note, so the model does not invent files.
 *
 * The git invocation is the SAME as the snapshot engine's (--git-dir in
 * userData/snapshots/<hash> with --work-tree in the project, binary and PATH
 * resolved at load — snapshotGit in electron/lib/snapshot/index.ts): a single
 * source, without duplicating gitDirFor nor the binary resolution (B3).
 */
export async function verifyTurnChanges(ctx: ToolContext): Promise<VerifyChangesResult> {
  const turn = ctx.getTurnSnapshot?.()
  if (!turn?.start) {
    return {
      changes: [],
      note: turn?.failed
        ? 'no changes recorded (the turn\'s initial snapshot failed: ' + (turn.error ?? 'unknown reason') + ')'
        : 'no changes recorded',
    }
  }
  try {
    const end = await capture(ctx.directory)
    if (end === turn.start) return { changes: [] }
    // --name-status gives the status per file (A/M/D); each file's patch
    // is measured separately for the individual patchSize.
    const statusLines = (await snapshotGit(ctx.directory, ['diff', '--name-status', turn.start, end]))
      .split('\n')
      .filter(Boolean)
    if (statusLines.length === 0) return { changes: [] }

    const changes: VerifyChangesResult['changes'] = []
    for (const line of statusLines) {
      const parts = line.split('\t')
      // Rename/copy report two paths (source\t destination) — we use the last one
      const file = parts[parts.length - 1]
      if (!file) continue
      const status = parts[0]
      const state = status === 'A' ? 'created' : status === 'D' ? 'removed' : 'edited'
      let patchSize = 0
      try {
        patchSize = (await snapshotGit(ctx.directory, ['diff', turn.start, end, '--', file])).length
      } catch {
        // patchSize is informative — it does not bring the check down
      }
      changes.push({ path: file, state, patchSize })
    }
    return { changes }
  } catch (err) {
    return { changes: [], note: `failed to check changes: ${errorToText(err)}` }
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
