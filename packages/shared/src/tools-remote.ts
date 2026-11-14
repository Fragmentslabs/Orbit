import type { McpConfig, McpServerConfig, McpServerStatus } from "./mcp"

/**
 * The Tools screen (MCP servers, skills, hooks) of ANOTHER desktop, over the companion
 * API. Every request here needs the `control` grant (permissions.ts) and only a desktop
 * can make it: the phone has no Tools screen.
 *
 * What does not exist remotely, because it needs this computer: the OAuth flow of an
 * MCP server (a browser on the machine that owns the server), importing a skill from a
 * file dialog, the Nodara/Fracta integrations (local apps) and "ask Orbit" creation
 * (a chat that would run on the wrong machine).
 */

export type ToolsRequest =
  | { type: "mcp:config" }
  | { type: "mcp:status" }
  | { type: "mcp:save"; config: McpConfig }
  | { type: "mcp:reconnect"; name?: string }
  | { type: "mcp:descriptions"; name: string }
  | { type: "mcp:optimize"; name: string }
  | { type: "mcp:revoke-trust"; name: string }
  | { type: "skills:list"; directory?: string }
  | { type: "skills:meta"; directory?: string }
  | { type: "skills:create"; data: { name: string; description?: string; content: string; slug?: string; oldSlug?: string } }
  | { type: "skills:remove"; slug: string }
  | { type: "skills:set-pref"; slug: string; patch: { pin?: boolean; never?: boolean } }
  | { type: "skills:optimize"; slug: string; directory?: string; language?: string }
  | { type: "skills:pending" }
  | { type: "skills:approve"; slug: string }
  | { type: "skills:discard"; slug: string }
  | { type: "hooks:list" }
  | { type: "hooks:add"; input: unknown }
  | { type: "hooks:update"; id: string; input: unknown }
  | { type: "hooks:toggle"; id: string; enabled: boolean }
  | { type: "hooks:remove"; id: string }

export const TOOLS_REQUEST_TYPES: ReadonlySet<string> = new Set<ToolsRequest["type"]>([
  "mcp:config",
  "mcp:status",
  "mcp:save",
  "mcp:reconnect",
  "mcp:descriptions",
  "mcp:optimize",
  "mcp:revoke-trust",
  "skills:list",
  "skills:meta",
  "skills:create",
  "skills:remove",
  "skills:set-pref",
  "skills:optimize",
  "skills:pending",
  "skills:approve",
  "skills:discard",
  "hooks:list",
  "hooks:add",
  "hooks:update",
  "hooks:toggle",
  "hooks:remove",
])

export function isToolsRequestType(type: string): boolean {
  return TOOLS_REQUEST_TYPES.has(type)
}

// ─── Secrets ────────────────────────────────────────────────────────────────
//
// The local screen shows an MCP server's env, headers and OAuth client secret in its
// edit form, so a `control` peer is entitled to EDIT them — but not to READ them:
// that would copy every token on this machine to another one just because the screen
// was opened. Values leave masked; the keys, the URL and the command stay readable
// (they are the definition of the server, and what the screen needs to draw it).
// When the peer saves, a masked value means "keep what you have", so editing a server
// never clobbers a secret the peer never saw. A new value replaces it; removing the
// key removes it.

export const MCP_SECRET_MASK = "••••••••"
/** In a URL the mask stays plain ASCII, so the address is still readable in the list. */
const URL_MASK = "***"

/** Query-string values and the password of a URL are credentials (`?key=…`, `user:pass@`). */
export function maskUrlSecrets(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!parsed.password && [...parsed.searchParams.keys()].length === 0) return url
  if (parsed.password) parsed.password = URL_MASK
  for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, URL_MASK)
  return parsed.toString()
}

function maskValues(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) return undefined
  return Object.fromEntries(Object.keys(values).map((key) => [key, MCP_SECRET_MASK]))
}

export function maskMcpServer(server: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...server }
  if (server.url) out.url = maskUrlSecrets(server.url)
  if (server.env) out.env = maskValues(server.env)
  if (server.headers) out.headers = maskValues(server.headers)
  if (server.oauth?.clientSecret) out.oauth = { ...server.oauth, clientSecret: MCP_SECRET_MASK }
  return out
}

export function maskMcpConfig(config: McpConfig): McpConfig {
  return { servers: config.servers.map(maskMcpServer) }
}

export function maskMcpStatus(statuses: McpServerStatus[]): McpServerStatus[] {
  return statuses.map((status) => ({ ...status, config: maskMcpServer(status.config) }))
}

function restoreValues(
  incoming: Record<string, string> | undefined,
  stored: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!incoming) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== MCP_SECRET_MASK) out[key] = value
    else if (stored && key in stored) out[key] = stored[key]
    // A mask with nothing behind it (the key is new, or the server was renamed): there is no
    // secret to keep and the mask must never be saved as one.
  }
  return out
}

function restoreServer(incoming: McpServerConfig, stored: McpServerConfig | undefined): McpServerConfig {
  const out: McpServerConfig = { ...incoming }
  if (incoming.url && stored?.url && incoming.url === maskUrlSecrets(stored.url)) out.url = stored.url
  if (incoming.env) out.env = restoreValues(incoming.env, stored?.env)
  if (incoming.headers) out.headers = restoreValues(incoming.headers, stored?.headers)
  if (incoming.oauth?.clientSecret === MCP_SECRET_MASK) {
    const kept = stored?.oauth?.clientSecret
    const { clientSecret: _masked, ...rest } = incoming.oauth
    out.oauth = kept ? { ...rest, clientSecret: kept } : rest
  }
  return out
}

/** The config a peer sent back, with every masked value replaced by what this machine has saved. */
export function restoreMcpSecrets(incoming: McpConfig, stored: McpConfig): McpConfig {
  const byName = new Map(stored.servers.map((server) => [server.name, server]))
  return { servers: incoming.servers.map((server) => restoreServer(server, byName.get(server.name))) }
}
