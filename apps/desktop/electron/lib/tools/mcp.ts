import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { listMcpStatus } from '../mcp'

/**
 * Tools de conexão MCP (mcp_connect / mcp_update / mcp_servers).
 *
 * Elas NÃO gravam nada: apenas PROPÕEM. A conexão só é criada ou alterada
 * quando o usuário aceita no card que aparece na conversa — é o card que
 * chama mcp:save / mcp:auth. É por isso que elas podem ser tratadas como
 * nativas, sem pedir permissão: uma proposta não muda o estado do app, e o
 * ato de conectar (que dá ao agente acesso a ferramentas novas) continua
 * sendo uma decisão explícita de quem usa.
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

/** Campos comuns a criar e editar uma conexão. */
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

/** Falha de validação devolvida ao modelo — ele consegue corrigir e repetir. */
function invalid(message: string): string {
  return `Conexão não proposta: ${message}`
}

function describeEntry(input: { name: string; type: string; url?: string; command?: string }): string {
  const target = input.type === 'http' ? input.url : input.command
  return `"${input.name}" (${input.type}: ${target})`
}

/**
 * A proposta aparece como card na conversa; nada é gravado até o usuário
 * aceitar ali. O texto final orienta o modelo a parar e esperar.
 */
function proposedText(entry: string, extra?: string): string {
  return (
    `Conexão ${entry} proposta${extra ? ` (${extra})` : ''}. ` +
    'Um card apareceu na conversa — quem aceita, autoriza o login e conecta é o usuário, ali. ' +
    'Nada foi gravado ainda: não diga que a conexão está feita e não tente usar as ferramentas ' +
    'desse servidor antes de ele aceitar.'
  )
}

export function createMcpConnectTool() {
  return tool({
    description:
      'Proposes connecting a NEW MCP server to Orbit. Nothing is saved: the proposal appears as a card in the conversation and only the user can accept it there (and complete the login when the server requires OAuth). Call mcp_servers first to check whether the server is already configured — an existing connection must be changed with mcp_update. After calling, tell the user in one or two sentences what they need to decide in the card.',
    inputSchema: z.object({
      name: z
        .string()
        .describe('Unique name for the server; it becomes the prefix of its tools (e.g.: "notion" -> notion_search)'),
      ...connectionFields,
    }),
    execute: async (input) => {
      if (input.type === 'http' && !input.url?.trim()) return invalid('type=http exige "url".')
      if (input.type === 'stdio' && !input.command?.trim()) return invalid('type=stdio exige "command".')
      const existing = listMcpStatus().find((server) => server.config.name === input.name)
      if (existing) {
        return invalid(
          `já existe uma conexão chamada "${input.name}" (${existing.state}). Para mudá-la use mcp_update.`,
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
        return invalid(`não existe conexão chamada "${input.name}". Use mcp_servers para ver as que existem.`)
      }
      // O que vale é a config RESULTANTE: o que não vem no pedido continua
      // como está (o card faz a mesma mescla sobre a entrada atual).
      const type = input.type ?? existing.config.type
      const url = input.url ?? existing.config.url
      const command = input.command ?? existing.config.command
      const target = type === 'http' ? url : command
      if (type === 'http' && !url?.trim()) return invalid('type=http exige "url".')
      if (type === 'stdio' && !command?.trim()) return invalid('type=stdio exige "command".')
      // `type` é estrutural (diz como ler o resto), não uma alteração: uma
      // chamada só com ele não muda nada e seria uma proposta vazia.
      const changes = Object.keys(input).filter(
        (key) => key !== 'name' && key !== 'reason' && key !== 'type',
      )
      if (changes.length === 0) return invalid('nenhum campo para alterar foi informado.')
      return proposedText(`"${input.name}" (${type}: ${target})`, `altera ${changes.join(', ')}`)
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
      if (servers.length === 0) return 'Nenhum servidor MCP configurado no Orbit.'
      return servers
        .map((server) => {
          const target = server.config.url ?? server.config.command ?? ''
          const parts = [`- ${server.config.name} (${server.config.type}) — ${server.state}`]
          if (target) parts.push(target)
          if (server.usesOAuth) parts.push(server.authorized ? 'oauth: autorizado' : 'oauth: sem autorização')
          if (server.error) parts.push(`erro: ${server.error}`)
          if (server.toolNames.length > 0) parts.push(`tools: ${server.toolNames.join(', ')}`)
          return parts.join(' | ')
        })
        .join('\n')
    },
  })
}

/** As três tools de conexão MCP, como um conjunto só (chat e código). */
export function createMcpTools(): ToolSet {
  return {
    mcp_connect: createMcpConnectTool(),
    mcp_update: createMcpUpdateTool(),
    mcp_servers: createMcpServersTool(),
  }
}
