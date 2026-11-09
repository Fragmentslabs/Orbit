import { tool, type ToolSet } from 'ai'
import { ASK_WHEN_VAGUE } from './proposal-guidance'
import { z } from 'zod'
import { listMcpStatus } from '../mcp'

/**
 * MCP connection tools (mcp_connect / mcp_update / mcp_servers).
 *
 * They write NOTHING: they only PROPOSE. The connection is only created or changed
 * when the user accepts in the card that appears in the conversation — it is the card that
 * calls mcp:save / mcp:auth. That is why they can be treated as
 * native, without asking permission: a proposal does not change the app's state, and the
 * act of connecting (which gives the agent access to new tools) remains
 * an explicit decision of whoever uses it.
 */

const oauthSchema = z
  .object({
    clientId: z
      .string()
      .optional()
      .describe('OAuth client_id of an app already created at the provider (skips dynamic registration)'),
    clientSecret: z.string().optional().describe('OAuth client_secret (confidential clients)'),
    scope: z.string().optional().describe('Space-separated scopes to request'),
  })
  .optional()
  .describe('Only for providers that refuse dynamic registration (e.g.: Figma answers 403 to /register)')

/** Fields common to creating and editing a connection. */
const connectionFields = {
  type: z
    .enum(['http', 'stdio'])
    .describe('"http" for a Streamable HTTP endpoint (URL), "stdio" for a local process (command)'),
  url: z.string().optional().describe('type=http: Streamable HTTP endpoint URL'),
  command: z.string().optional().describe('type=stdio: executable to spawn'),
  args: z.array(z.string()).optional().describe('type=stdio: arguments for the command'),
  env: z.record(z.string(), z.string()).optional().describe('type=stdio: environment variables for the child process'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('type=http: custom headers sent on every request (e.g.: Authorization)'),
  oauth: oauthSchema,
}

/** Validation failure returned to the model — it can correct it and retry. */
function invalid(message: string): string {
  return `Connection not proposed: ${message}`
}

function describeEntry(input: { name: string; type: string; url?: string; command?: string }): string {
  const target = input.type === 'http' ? input.url : input.command
  return `"${input.name}" (${input.type}: ${target})`
}

/**
 * The proposal appears as a card in the conversation; nothing is written until the user
 * accepts there. The final text guides the model to stop and wait.
 */
function proposedText(entry: string, extra?: string): string {
  return (
    `Connection ${entry} proposed${extra ? ` (${extra})` : ''}. ` +
    'A card appeared in the conversation — the user is the one who accepts, authorizes the login and connects, there. ' +
    'Nothing has been saved yet: do not say the connection is done and do not try to use the tools ' +
    'of this server before the user accepts.'
  )
}

export function createMcpConnectTool() {
  return tool({
    description:
      'Proposes connecting a NEW MCP server to Orbit. Nothing is saved: the proposal appears as a card in the conversation and only the user can accept it there (and complete the login when the server requires OAuth). Call mcp_servers first to check whether the server is already configured — an existing connection must be changed with mcp_update. After calling, tell the user in one or two sentences what they need to decide in the card. ' + ASK_WHEN_VAGUE,
    inputSchema: z.object({
      name: z
        .string()
        .describe('Unique name for the server; it becomes the prefix of its tools (e.g.: "notion" -> notion_search)'),
      ...connectionFields,
    }),
    execute: async (input) => {
      if (input.type === 'http' && !input.url?.trim()) return invalid('type=http requires "url".')
      if (input.type === 'stdio' && !input.command?.trim()) return invalid('type=stdio requires "command".')
      const existing = listMcpStatus().find((server) => server.config.name === input.name)
      if (existing) {
        return invalid(
          `a connection named "${input.name}" already exists (${existing.state}). To change it use mcp_update.`,
        )
      }
      return proposedText(describeEntry(input))
    },
  })
}

export function createMcpUpdateTool() {
  return tool({
    description:
      'Proposes a change to an EXISTING MCP server connection (wrong URL, missing/expired header or token, OAuth client settings, enabling/disabling it). Nothing is saved: the proposal appears as a card in the conversation and only the user can accept it there. Use mcp_servers first to read the current configuration and the connection error. Send only the fields that change. After calling, tell the user in one or two sentences what they need to decide in the card.',
    inputSchema: z.object({
      name: z.string().describe('Name of the existing server to change (as shown by mcp_servers)'),
      reason: z
        .string()
        .optional()
        .describe('Why the connection is being changed (e.g.: "the token expired") — shown to the user in the card'),
      enabled: z.boolean().optional().describe('false disables the server without removing it'),
      permissionMode: z
        .enum(['ask', 'approve', 'full'])
        .optional()
        .describe('Permission mode override for the tools of this server'),
      ...connectionFields,
    }),
    execute: async (input) => {
      const existing = listMcpStatus().find((server) => server.config.name === input.name)
      if (!existing) {
        return invalid(`there is no connection named "${input.name}". Use mcp_servers to see the existing ones.`)
      }
      // What counts is the RESULTING config: what does not come in the request stays
      // as it is (the card does the same merge over the current input).
      const type = input.type ?? existing.config.type
      const url = input.url ?? existing.config.url
      const command = input.command ?? existing.config.command
      const target = type === 'http' ? url : command
      if (type === 'http' && !url?.trim()) return invalid('type=http requires "url".')
      if (type === 'stdio' && !command?.trim()) return invalid('type=stdio requires "command".')
      // `type` is structural (it says how to read the rest), not a change: a
      // call with only it changes nothing and would be an empty proposal.
      const changes = Object.keys(input).filter(
        (key) => key !== 'name' && key !== 'reason' && key !== 'type',
      )
      if (changes.length === 0) return invalid('no field to change was provided.')
      return proposedText(`"${input.name}" (${type}: ${target})`, `changes ${changes.join(', ')}`)
    },
  })
}

export function createMcpServersTool() {
  return tool({
    description:
      'Reads the MCP servers configured in Orbit with their connection state, error and available tools. Use it before changing a connection (mcp_update) and to diagnose failures.',
    inputSchema: z.object({}),
    execute: async () => {
      const servers = listMcpStatus()
      if (servers.length === 0) return 'No MCP servers configured in Orbit.'
      return servers
        .map((server) => {
          const target = server.config.url ?? server.config.command ?? ''
          const parts = [`- ${server.config.name} (${server.config.type}) — ${server.state}`]
          if (target) parts.push(target)
          if (server.usesOAuth) parts.push(server.authorized ? 'oauth: authorized' : 'oauth: not authorized')
          if (server.error) parts.push(`error: ${server.error}`)
          if (server.toolNames.length > 0) parts.push(`tools: ${server.toolNames.join(', ')}`)
          return parts.join(' | ')
        })
        .join('\n')
    },
  })
}

/** The three MCP connection tools, as a single set (chat and code). */
export function createMcpTools(): ToolSet {
  return {
    mcp_connect: createMcpConnectTool(),
    mcp_update: createMcpUpdateTool(),
    mcp_servers: createMcpServersTool(),
  }
}
