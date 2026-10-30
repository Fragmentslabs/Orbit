import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { search } from './search'
import type { ToolFamily } from './catalog'
import { CORE_SET, MAX_TOOLS_PER_FAMILY, estimateTokens } from './catalog'

/**
 * The funnel's two bridges: `tools_load` and `tools_list`.
 *
 * They hold no state. "Loading" only means returning the manual and the
 * confirmation; what activates the family is the history derivation (`active.ts`),
 * which sees this same call on the next step. That is what makes the mechanism
 * immune to retry, provider rotation and compaction.
 */

export { MAX_TOOLS_PER_FAMILY }

export interface BridgeContext {
  families: readonly ToolFamily[]
  /** Real ToolSet — the descriptions for the search come from it. */
  tools: ToolSet
}

function descriptionOf(tools: ToolSet, name: string): string {
  const def = tools[name] as { description?: string } | undefined
  const raw = def?.description ?? ''
  // A third-party MCP description is UNTRUSTED TEXT: a single line, without
  // instruction markers, truncated. The cut is marked — never silently.
  const clean = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`<>#]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!clean) return ''
  return clean.length > 200 ? `${clean.slice(0, 200)}… (full description when loading)` : clean
}

/** How many tools a `query` activates inside a family. */
const QUERY_LIMIT = 8

/**
 * The search inside a family. Deterministic on purpose: the bridge answers with it
 * and `deriveActive` runs it again to know what became active — both must agree.
 */
export function queryFamily(tools: ToolSet, family: ToolFamily, query: string): string[] {
  return search(
    family.tools.map((name) => ({ name, text: `${name} ${descriptionOf(tools, name)}` })),
    [query],
    QUERY_LIMIT,
  ).map((r) => r.name)
}

function label(family: ToolFamily): string {
  return family.mcp ? `@mcp:${family.id.replace(/^mcp:/, '')}` : family.id
}

function findFamily(
  families: readonly ToolFamily[],
  input: { family?: string; server?: string },
): ToolFamily | undefined {
  if (input.family) return families.find((f) => f.id === input.family)
  if (input.server) return families.find((f) => f.id === `mcp:${input.server}`)
  return undefined
}

export function createToolBridgeTools(ctx: BridgeContext) {
  const ids = ctx.families.map(label).join(', ')

  const tools_load = tool({
    description:
      'Loads a family of tools into this step. The system prompt lists the families, what each one does, and which ones are disabled here. Call this when the work needs a tool that is not loaded yet; then call the real tool in the next step. Without arguments it returns the catalog. With `server` + `query` it searches inside a large MCP server instead of loading it whole. Do not use it to call a tool — it only loads.',
    inputSchema: z.object({
      family: z.string().optional().describe('Family id from the catalog (e.g. "documents", "video", "design").'),
      server: z.string().optional().describe('MCP server name, without the @mcp: prefix.'),
      tools: z.array(z.string()).optional().describe('Exact tool names to load, when you already know them.'),
      query: z.string().optional().describe('Words describing what you need — searches inside a large family.'),
    }),
    execute: async ({ family, server, tools: names, query }) => {
      // With no argument: returns the whole catalog (it is the "I don't know what exists").
      if (!family && !server && !names?.length && !query) {
        return `Families available in this turn:\n${ctx.families
          .map((f) =>
            f.unavailable
              ? `- ${label(f)} — DISABLED: ${f.unavailable}`
              : `- ${label(f)} — ${f.tools.length} tools: ${f.description}`,
          )
          .join('\n')}`
      }

      // Explicit names: validates against the catalog instead of accepting silently.
      if (names?.length) {
        // The core is always loaded: naming it is not an error.
        const existing = new Set([...ctx.families.flatMap((f) => f.tools), ...Object.keys(ctx.tools).filter((n) => CORE_SET.has(n))])
        const unknown = names.filter((n) => !existing.has(n))
        if (unknown.length > 0) {
          const suggestions = search(
            ctx.families.flatMap((f) => f.tools.map((name) => ({ name, text: `${name} ${descriptionOf(ctx.tools, name)}` }))),
            unknown,
            5,
          )
          return `These tools do not exist in this turn: ${unknown.join(', ')}.${
            suggestions.length ? ` Similar: ${suggestions.map((s) => s.name).join(', ')}.` : ''
          }\nFamilies: ${ids}`
        }
        return `Loaded: ${names.join(', ')}. Call the tool now.`
      }

      const requested = findFamily(ctx.families, { family, server })
      // Disabled family: stating the REASON is the point — the model should not have
      // to find out by calling the tool and getting an error.
      if (requested?.unavailable) {
        return `${label(requested)} is DISABLED in this turn: ${requested.unavailable}. Do not insist: explain it to the user or use another family.`
      }
      if (requested) {
        // Large server: it does not load whole even with an empty query.
        if (requested.tools.length > MAX_TOOLS_PER_FAMILY && !query) {
          return `${label(requested)} has ${requested.tools.length} tools — too large to load whole. Use tools_load({ server: "${label(requested).replace(/^@mcp:/, '')}", query: "<what you need>" }).`
        }
        if (query) {
          const found = queryFamily(ctx.tools, requested, query)
          if (found.length === 0) {
            return `Nothing in ${label(requested)} matched "${query}". Available names:\n${requested.tools.join('\n')}`
          }
          return `${label(requested)} — ${found.join(', ')} (loaded). Call the tool now.${
            requested.manual ? `\n\n${requested.manual}` : ''
          }`
        }
        return `${label(requested)} ACTIVE — ${requested.tools.length} tools: ${requested.tools.join(', ')}. Call the tool now.${
          requested.manual ? `\n\n${requested.manual}` : ''
        }`
      }

      // Unknown family: it returns the catalog instead of "not found".
      return `Family "${family ?? server}" does not exist in this turn. Available: ${ids}`
    },
  })

  const tools_list = tool({
    description:
      'Lists the tools of a family (or server) with one line each, without loading them. Use it when you do not know the tool name and the catalog only showed a count.',
    inputSchema: z.object({
      family: z.string().optional().describe('Family id. Omit to list every family.'),
      server: z.string().optional().describe('MCP server name.'),
    }),
    execute: async ({ family, server }) => {
      const target = family || server ? findFamily(ctx.families, { family, server }) : undefined
      if (!target) {
        return ctx.families
          .map((f) => `${label(f)} — ${f.tools.length} tools`)
          .join('\n')
      }
      if (target.unavailable) return `${label(target)} is DISABLED: ${target.unavailable}.`
      return target.tools
        .slice(0, 120)
        .map((name) => `- ${name}: ${descriptionOf(ctx.tools, name) || 'no description'}`)
        .join('\n')
    },
  })

  return { tools_load, tools_list }
}

/** Tokens of the manual that travels in `tools_load` — Phase 3 telemetry. */
export function manualTokens(family: ToolFamily): number {
  return family.manual ? estimateTokens(family.manual) : 0
}
