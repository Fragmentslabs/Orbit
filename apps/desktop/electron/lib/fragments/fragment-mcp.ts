import type { FragmentCallResult, FragmentManifest } from '@shared/fragments'
import { callMcpToolByName, listMcpServerToolNames } from '../mcp'
import { mcpResultToText } from '../mcp/result'
import { createBudget } from './fragment-budget'

/**
 * `orbit.mcp` — a fragment uses the MCP servers the person already connected.
 *
 * Reuses the app's own MCP clients (so OAuth, headers and env stay in the main process).
 * A call needs the server/tool pair to be in `manifest.mcp` AND the person's "mcp" grant
 * (checked by the broker); the server must be connected right now. The result is flattened
 * to text (images and audio are dropped — a fragment gets no media files) and capped.
 */

export const MCP_LIMITS = {
  maxResultChars: 60_000,
  maxArgsBytes: 64 * 1024,
  timeoutMs: 60_000,
  perMinute: 20,
  concurrent: 2,
} as const

const budget = createBudget({ label: 'orbit.mcp', perMinute: MCP_LIMITS.perMinute, concurrent: MCP_LIMITS.concurrent })

function fail(code: string, message: string): FragmentCallResult {
  return { ok: false, error: { code, message } }
}

/** What the page may see of its MCP access: the declared pairs and whether each server is up now. */
export function fragmentMcpList(manifest: FragmentManifest): FragmentCallResult {
  return {
    ok: true,
    value: manifest.mcp.map(({ server, tools }) => {
      const live = listMcpServerToolNames(server)
      return { server, connected: live !== null, tools: tools.map((name) => ({ name, available: live?.includes(name) ?? false })) }
    }),
  }
}

export async function fragmentMcpCall(manifest: FragmentManifest, params: Record<string, unknown>): Promise<FragmentCallResult> {
  const { server, tool } = params
  if (typeof server !== 'string' || typeof tool !== 'string' || !server || !tool) {
    return fail('invalid_params', 'orbit.mcp.call needs { server, tool, args? }')
  }
  const args = params.args ?? {}
  if (typeof args !== 'object' || Array.isArray(args) || args === null) return fail('invalid_params', 'args must be an object')
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MCP_LIMITS.maxArgsBytes) {
    return fail('invalid_params', `args too large (limit ${MCP_LIMITS.maxArgsBytes / 1024}KB)`)
  }
  const declared = manifest.mcp.find((entry) => entry.server === server)
  if (!declared || !declared.tools.includes(tool)) {
    return fail('tool_not_allowed', `This fragment did not declare the tool "${tool}" of "${server}".`)
  }
  if (listMcpServerToolNames(server) === null) {
    return fail('mcp_unavailable', `The MCP server "${server}" is not connected. Ask the person to connect it in Orbit's settings.`)
  }

  const slot = budget.take(manifest.id)
  if ('refused' in slot) return fail('rate_limited', slot.refused)
  try {
    const result = await callMcpToolByName(server, tool, args as Record<string, unknown>, MCP_LIMITS.timeoutMs)
    const full = await mcpResultToText(result, { saveImage: async () => null, canShow: false, canDescribe: false })
    const text = full.slice(0, MCP_LIMITS.maxResultChars)
    if ((result as { isError?: boolean } | null)?.isError === true) return fail('mcp_tool_error', text)
    return { ok: true, value: { text, truncated: full.length > text.length } }
  } catch (err) {
    return fail('mcp_failed', err instanceof Error ? err.message : String(err))
  } finally {
    slot.release()
  }
}
