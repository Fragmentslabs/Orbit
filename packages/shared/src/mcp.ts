/**
 * MCP (Model Context Protocol): external tool servers.
 * Config persisted in orbit-data/mcp-config.json; status travels via IPC.
 */

/**
 * Settings of the OAuth flow of an HTTP server.
 *
 * By default Orbit registers itself with the authorization server
 * (dynamic registration, RFC 7591). Providers that only accept pre-registered
 * clients (Figma answers 403 to /register) require the user to
 * create an OAuth app and paste the client_id/client_secret here.
 */
export interface McpOAuthConfig {
  /** client_id of an OAuth app already created at the provider (skips the dynamic registration) */
  clientId?: string
  /** client_secret of the app (confidential clients) */
  clientSecret?: string
  /** client_name sent in the dynamic registration (default: "Orbit") */
  clientName?: string
  /** requested scopes, space separated (default: the ones announced by the server) */
  scope?: string
}

export interface McpServerConfig {
  /** Unique name (becomes the tools prefix: <name>_<tool>) */
  name: string
  type: "http" | "stdio"
  /** type=http: endpoint URL (Streamable HTTP) */
  url?: string
  /** type=stdio: executable + arguments */
  command?: string
  args?: string[]
  /** default true */
  enabled?: boolean
  /** type=stdio: environment variables injected into the child process */
  env?: Record<string, string>
  /** type=http: custom HTTP headers sent in every request */
  headers?: Record<string, string>
  /** type=stdio: working directory of the child process */
  cwd?: string
  /** Override of the global permission mode for tools of this server */
  permissionMode?: "ask" | "approve" | "full"
  /** Automatic reconnection with exponential backoff (default true) */
  autoReconnect?: boolean
  /** type=http: settings of the OAuth flow (pre-registered client, name, scope) */
  oauth?: McpOAuthConfig
}

export interface McpConfig {
  servers: McpServerConfig[]
}

export type McpConnectionState =
  | "connected"
  | "connecting"
  | "error"
  | "disabled"
  | "unauthorized"

export interface McpServerStatus {
  config: McpServerConfig
  state: McpConnectionState
  error?: string
  toolNames: string[]
  /** The server authenticates via OAuth (http without its own Authorization header) */
  usesOAuth?: boolean
  /** An OAuth token is already saved — false = never authorized on this device */
  authorized?: boolean
}
