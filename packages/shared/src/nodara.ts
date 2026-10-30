/**
 * Nodara: official integration (control of Android devices via MCP).
 * The state crosses two ends — the Nodara app running on the machine and the MCP
 * server "Nodara" registered and connected in Orbit.
 */

export type NodaraState =
  /** Without ~/.nodara/mcp.json: Nodara never ran on this machine */
  | 'not-installed'
  /** Bridge file exists, but the local server does not answer (app closed) */
  | 'stopped'
  /** Bridge off in the Nodara settings, or MCP server disabled in Orbit */
  | 'disabled'
  /** Nodara up, but still without an MCP server registered in Orbit */
  | 'installed'
  /** Registered in Orbit, but the MCP connection failed (expired token, changed port...) */
  | 'error'
  /** Connected: the tools are in the agent's toolset */
  | 'connected'

export interface NodaraStatus {
  state: NodaraState
  /** There is a "Nodara" entry in Orbit's mcp-config.json */
  linked: boolean
  /** Saved credential differs from the one published by Nodara (token regenerated / port changed) */
  tokenStale: boolean
  mcpUrl?: string
  /** Number of tools exposed when connected */
  toolCount: number
  /** MCP connection error, or a code of the integration itself (nodara-not-running...) */
  error?: string
}
