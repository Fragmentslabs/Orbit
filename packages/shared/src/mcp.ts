/**
 * MCP (Model Context Protocol): servidores externos de ferramentas.
 * Config persistida em orbit-data/mcp-config.json; status trafega via IPC.
 */

/**
 * Ajustes do fluxo OAuth de um servidor HTTP.
 *
 * Por padrão o Orbit se registra sozinho no servidor de autorização
 * (registro dinâmico, RFC 7591). Provedores que só aceitam clientes
 * pré-cadastrados (o Figma responde 403 ao /register) exigem que o usuário
 * crie um app OAuth e cole aqui o client_id/client_secret.
 */
export interface McpOAuthConfig {
  /** client_id de um app OAuth já criado no provedor (pula o registro dinâmico) */
  clientId?: string
  /** client_secret do app (clientes confidenciais) */
  clientSecret?: string
  /** client_name enviado no registro dinâmico (default: "Orbit") */
  clientName?: string
  /** escopos pedidos, separados por espaço (default: os anunciados pelo servidor) */
  scope?: string
}

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
  /** Override do modo de permissão global para ferramentas deste servidor */
  permissionMode?: "ask" | "approve" | "full"
  /** Reconexão automática com backoff exponencial (default true) */
  autoReconnect?: boolean
  /** type=http: ajustes do fluxo OAuth (client pré-registrado, nome, escopo) */
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
  /** O servidor autentica via OAuth (http sem header Authorization próprio) */
  usesOAuth?: boolean
  /** Já existe token OAuth salvo — false = nunca foi autorizado neste dispositivo */
  authorized?: boolean
}
