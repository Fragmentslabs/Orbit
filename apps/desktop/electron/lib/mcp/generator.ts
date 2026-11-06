import type { McpGenerationResult, McpServerConfig } from '@shared/mcp'
import type { RoutineModel } from '@shared/routines'
import { askModelForJson, contextLines } from '../headless-json'

/**
 * Configuring an MCP server from a description: the user says which service or tool
 * they want to connect and the model proposes the transport and the command or URL.
 * Headless; nothing is saved or started here — the server dialog opens filled in,
 * the user completes the keys and saves.
 *
 * The model must NOT invent credentials: secrets come out as obvious placeholders
 * for the user to replace, and the server is never connected before the review.
 */

const SYSTEM = `You configure MCP (Model Context Protocol) servers for Orbit, an AI coding agent.

From the user's description, produce ONE server configuration.

Rules:
- "type": "stdio" for a local command (most community servers: npx, uvx, docker, node, python) or "http" for a remote Streamable HTTP endpoint (a URL).
- stdio: "command" is only the executable ("npx", "uvx", "docker"); "args" is an array of its arguments, e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]. Use the well-known official package when there is one.
- http: "url" is the endpoint. Only use a URL you are confident about; otherwise answer with the stdio package or leave the URL as "https://" followed by a clear placeholder host.
- "name": short, lowercase, letters, digits and hyphens only (it becomes the prefix of the tools).
- "env" (stdio) and "headers" (http): ONLY the variables the server needs. NEVER invent a real token or key: put an obvious placeholder as the value, like "<YOUR_GITHUB_TOKEN>". Omit the field when nothing is needed.
- Do not include "cwd", "oauth" or anything not listed here.
- If the description does not name something you can configure, return the closest honest server and keep the placeholders visible.

Answer with JSON ONLY — no prose, no markdown fences:
{"name":"github","type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"<YOUR_GITHUB_TOKEN>"}}
or
{"name":"docs","type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer <YOUR_TOKEN>"}}`

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() && (typeof entry === 'string' || typeof entry === 'number')) out[key.trim()] = String(entry)
  }
  return Object.keys(out).length ? out : undefined
}

/** The model's JSON as a server config, or null when it cannot be one. */
export function suggestionFrom(raw: Record<string, unknown>): McpServerConfig | null {
  const name = typeof raw.name === 'string'
    ? raw.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    : ''
  if (!name) return null
  const type = raw.type === 'http' || (raw.type !== 'stdio' && typeof raw.url === 'string' && !raw.command) ? 'http' : 'stdio'

  if (type === 'http') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!url) return null
    const headers = stringRecord(raw.headers)
    return { name, type, url, enabled: true, ...(headers ? { headers } : {}) }
  }

  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (!command) return null
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : []
  const env = stringRecord(raw.env)
  return { name, type, command, args, enabled: true, ...(env ? { env } : {}) }
}

export async function generateMcpServer(
  description: string,
  model: RoutineModel,
  folders: string[],
  language?: string,
): Promise<McpGenerationResult> {
  const text = description.trim()
  if (!text) return { ok: false, error: 'Describe the server before generating.' }

  const context = contextLines(folders, language, [`Platform: ${process.platform}`])
  const answer = await askModelForJson(SYSTEM, `${context}\n\n## Server described by the user\n${text}`, model)
  if (!answer.ok) return answer
  const suggestion = suggestionFrom(answer.raw)
  if (!suggestion) return { ok: false, error: 'The model answered without a usable server. Try again or switch models.' }
  return { ok: true, suggestion }
}
