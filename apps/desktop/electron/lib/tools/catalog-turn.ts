import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolSet } from 'ai'
import { toolLimitFor, type SendMessageInput } from '@shared/chat'
import { buildToolSet, type ImageToolHooks, type ToolContext } from './index'
import {
  CHARS_PER_TOKEN,
  applyCeiling,
  classifyFamilies,
  schemaTokens,
  type ToolFamily,
} from './catalog'
import { createToolBridgeTools } from './load'
import { listMcpServerInstructions, listMcpServerPrefixes, listUnavailableMcpServers } from '../mcp'

/**
 * Assembles the turn's ToolSet **and** the catalog families — the input of the
 * on-demand tool funnel.
 *
 * Every turn comes through here, workers included; `onDemand` says whether the
 * funnel applies. A worker gets the static set (§6.7 of the plan — a worker is
 * short and narrow, a round-trip in it costs proportionally more).
 */
export function buildCatalog(
  input: SendMessageInput,
  ctx: ToolContext | null,
  imageHooks?: ImageToolHooks,
  modelVision?: boolean,
  win?: BrowserWindow,
): { tools: ToolSet; families: ToolFamily[]; onDemand: boolean } {
  const tools = buildToolSet(input, ctx, imageHooks, modelVision, win)
  // MCP servers become a family through the sanitized prefix with which the manager
  // names the tools (`<server>_<tool>`) — derived, never declared.
  const families = classifyFamilies(
    tools,
    input,
    listMcpServerPrefixes(),
    listUnavailableMcpServers(),
    listMcpServerInstructions(),
  )
  // A worker has no bridges: it gets the whole static set, with no map and no
  // trimming — a round-trip costs it proportionally more (§6.7 of the plan).
  const onDemand = input.orchestrationRole !== 'worker' && !input.options.profile
  // The bridges come in AFTER the classification: they are core, not a family.
  if (onDemand) {
    Object.assign(tools, createToolBridgeTools({ families, tools }))
  } else {
    // Handbrake only where the WHOLE set goes to the provider. On demand only the
    // active set is sent, and its cap is applied there (`deriveActive`): cutting
    // the full set would take a server out of the map with nothing loaded.
    applyCeiling(tools, families, toolLimitFor(input.providerId))
  }
  // The turn telemetry stays in the engine, where the offer and the history are at
  // the same point. Here there are no messages: a record without usage would answer half.
  if (process.env.ORBIT_DEBUG_TOOLSET === '1') dumpToolset(input, tools, families)
  return { tools, families, onDemand }
}

/**
 * Task 0 of the plan, field version: with `ORBIT_DEBUG_TOOLSET=1`, it writes to
 * orbit-data/toolset-debug.json how many tools and how many schema tokens each
 * family costs in THIS turn, and the total line in the console. It is the number that calibrates
 * the map and the cap of §6.4 — without it, any ceiling is a guess.
 *
 * `schemaTokens` uses chars/4 on purpose (it underestimates a little: less false
 * activation, more slack in the budget).
 */
function dumpToolset(
  input: SendMessageInput,
  tools: ToolSet,
  families: ToolFamily[],
): void {
  try {
    const familyOf = new Map<string, string>()
    for (const family of families) {
      for (const name of family.tools) familyOf.set(name, family.id)
    }
    const items = Object.entries(tools)
      .map(([name, tool]) => ({
        name,
        family: familyOf.get(name) ?? 'core',
        tokens: schemaTokens(tool),
      }))
      .sort((a, b) => b.tokens - a.tokens)
    const total = items.reduce((sum, entry) => sum + entry.tokens, 0)

    const byFamily = new Map<string, { tools: number; tokens: number }>()
    for (const entry of items) {
      const current = byFamily.get(entry.family) ?? { tools: 0, tokens: 0 }
      byFamily.set(entry.family, {
        tools: current.tools + 1,
        tokens: current.tokens + entry.tokens,
      })
    }

    const file = path.join(app.getPath('userData'), 'orbit-data', 'toolset-debug.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          mode: input.mode,
          provider: input.providerId,
          tools: items.length,
          tokens: total,
          charsPerToken: CHARS_PER_TOKEN,
          byFamily: [...byFamily.entries()]
            .map(([id, values]) => ({ id, ...values }))
            .sort((a, b) => b.tokens - a.tokens),
          items,
        },
        null,
        2,
      ),
    )
    console.log(`[tools] ${input.mode}: ${items.length} tools, ~${total} schema tokens → ${file}`)
  } catch (error) {
    console.warn('[tools] toolset dump failed:', error)
  }
}
