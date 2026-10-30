/**
 * Fracta: official integration (databases via MCP).
 * The state crosses two ends — the Fracta app running on the machine and the MCP
 * server "Fracta" registered and connected in Orbit.
 */

export type FractaState =
  /** Without mcp.json in the Fracta data folder: Fracta never ran on this machine */
  | 'not-installed'
  /** mcp.json exists, but the Fracta backend does not answer (app closed) */
  | 'stopped'
  /** MCP server off in Fracta → Settings → Agents (MCP) */
  | 'disabled'
  /** Fracta up, but still without an MCP server registered in Orbit */
  | 'installed'
  /** Registered in Orbit, but the MCP connection failed (new token, changed port...) */
  | 'error'
  /** Connected: the tools are in the agent's toolset */
  | 'connected'

export interface FractaStatus {
  state: FractaState
  /** There is a "Fracta" entry in Orbit's mcp-config.json */
  linked: boolean
  /** Saved credential differs from the one published by Fracta (token generated again / port changed) */
  tokenStale: boolean
  mcpUrl?: string
  /** Number of tools exposed when connected */
  toolCount: number
  /** MCP connection error, or a code of the integration itself (fracta-not-running...) */
  error?: string
}
