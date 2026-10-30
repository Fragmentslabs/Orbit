import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../storage'
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
 * Why at the start of the turn and not at the end: the engine does not expose `onFinish`, and
 * instrumenting the stream to know the outcome would cost more than the data is worth.
 * From the history it is already possible to read what was called and what failed — what cannot
 * be done is separating it by exact turn, and for deciding on a family that changes nothing.
 */

export interface TurnMetrics {
  at: string
  /** Tools declared in the request (what the model saw). */
  offered: number
  /** Families with live tools. */
  families: number
  /** Families down, with the reason — they were not offered. */
  disabled: string[]
  /** How many tools_load the retained history asked for. */
  loads: number
  /** Tools actually called in the retained history. */
  calls: string[]
  /** Tool results marked as errors. */
  failed: number
  /** Families whose tools are in `calls`. */
  usedFamilies: string[]
}

/** Reads from the history what has already been called. `messages` is the turn's array. */
export function usageFromHistory(messages: readonly unknown[]): Pick<TurnMetrics, 'loads' | 'calls' | 'failed'> {
  const calls = new Set<string>()
  let failed = 0
  let loads = 0
  for (const message of messages) {
    // The history comes from disk and may bring a null item: without this guard the
    // whole read would throw, and the telemetry would lose the turn because of
    // a corrupted line.
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type === 'tool-call' && typeof p.toolName === 'string') {
        calls.add(p.toolName)
        if (p.toolName === 'tools_load') loads++
      }
      if (p.type === 'tool-result' && p.isError === true) failed++
    }
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
  messages: readonly unknown[]
}): Promise<void> {
  try {
    const usage = usageFromHistory(input.messages)
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
