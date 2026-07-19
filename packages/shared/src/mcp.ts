/**
 * MCP (Model Context Protocol): servidores externos de ferramentas.
 * Config persistida em orbit-data/mcp-config.json; status trafega via IPC.
 */

export interface McpServerConfig {
  /** Nome único (vira prefixo das tools: <nome>_<tool>) */
  name: string
  type: "http" | "stdio"
  /** type=http: URL do endpoint (Streamable HTTP) */
  url?: string
  /** type=stdio: executável + argumentos */
  command?: string
  args?: string[]
  /** default true */
  enabled?: boolean
  /** type=stdio: variáveis de ambiente injetadas no processo filho */
  env?: Record<string, string>
  /** type=http: cabeçalhos HTTP customizados enviados em cada requisição */
  headers?: Record<string, string>
  /** type=stdio: diretório de trabalho do processo filho */
  cwd?: string
}

export interface McpConfig {
  servers: McpServerConfig[]
}

export type McpConnectionState = "connected" | "connecting" | "error" | "disabled"

export interface McpServerStatus {
  config: McpServerConfig
  state: McpConnectionState
  error?: string
  toolNames: string[]
}
