import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../storage'
import type { MessagePart } from '@shared/chat'
import type { ToolFamily } from './catalog'

/**
 * Toolset outcome telemetry.
 *
 * Writes ONE JSON line per turn to `orbit-data/tool-metrics.jsonl` — append,
 * never a rewrite. The goal is to answer, without instrumenting the model, the two
 * questions that decide whether the toolset worked:
 *
 * 1. **Family offered and never called**: context cost paid for nothing.
 * 2. **Tool called and that failed**: the family is right, the tool is not.
 *
 * Recorded at the END of the turn, from the assistant message's ToolParts: the
 * model history does not carry tool parts of previous turns, so read at the start
 * it always came out empty.
 */

export interface TurnMetrics {
  at: string
  /** Largest active set declared in a step of the turn (what the model saw). */
  offered: number
  /** Families with live tools. */
  families: number
  /** Families down, with the reason — they were not offered. */
  disabled: string[]
  /** How many tools_load the turn called. */
  loads: number
  /** Tools actually called in the turn. */
  calls: string[]
  /** Tool calls that ended in error. */
  failed: number
  /** Families whose tools are in `calls`. */
  usedFamilies: string[]
}

/** Reads the turn's usage from the assistant message's parts. */
export function usageFromParts(parts: readonly MessagePart[]): Pick<TurnMetrics, 'loads' | 'calls' | 'failed'> {
  const calls = new Set<string>()
  let failed = 0
  let loads = 0
  for (const part of parts) {
    if (part.type !== 'tool') continue
    calls.add(part.tool)
    if (part.tool === 'tools_load') loads++
    if (part.state === 'error') failed++
  }
  return { loads, calls: [...calls].sort(), failed }
}

/**
 * Records the turn. It never throws: telemetry that brings the chat down is worse than
 * telemetry that is missing, so a disk error becomes a line in the console and it moves on.
 */
export async function recordTurn(input: {
  families: readonly ToolFamily[]
  offered: number
  parts: readonly MessagePart[]
}): Promise<void> {
  try {
    const usage = usageFromParts(input.parts)
    const used = new Set(usage.calls)
    const metrics: TurnMetrics = {
      at: new Date().toISOString(),
      offered: input.offered,
      families: input.families.filter((f) => !f.unavailable && f.tools.length > 0).length,
      disabled: input.families.filter((f) => f.unavailable).map((f) => f.id),
      ...usage,
      usedFamilies: input.families
        .filter((f) => f.tools.some((name) => used.has(name)))
        .map((f) => f.id),
    }
    await fsp.appendFile(path.join(dataDir(), 'tool-metrics.jsonl'), `${JSON.stringify(metrics)}\n`, 'utf8')
  } catch (err) {
    console.warn('[toolset] failed to append metrics:', err)
  }
}
