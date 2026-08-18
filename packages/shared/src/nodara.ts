/**
 * Nodara: integração oficial (controle de dispositivos Android via MCP).
 * O estado cruza duas pontas — o app Nodara rodando na máquina e o servidor
 * MCP "Nodara" registrado e conectado no Orbit.
 */

export type NodaraState =
  /** Sem ~/.nodara/mcp.json: o Nodara nunca rodou nesta máquina */
  | 'not-installed'
  /** Bridge file existe, mas o servidor local não responde (app fechado) */
  | 'stopped'
  /** Ponte desligada nas configurações do Nodara, ou servidor MCP desabilitado no Orbit */
  | 'disabled'
  /** Nodara no ar, mas ainda sem servidor MCP registrado no Orbit */
  | 'installed'
  /** Registrado no Orbit, porém a conexão MCP falhou (token vencido, porta trocada...) */
  | 'error'
  /** Conectado: as tools estão no toolset do agente */
  | 'connected'

export interface NodaraStatus {
  state: NodaraState
  /** Existe entrada "Nodara" no mcp-config.json do Orbit */
  linked: boolean
  /** Credencial salva diverge da publicada pelo Nodara (token regenerado / porta trocada) */
  tokenStale: boolean
  mcpUrl?: string
  /** Quantidade de ferramentas expostas quando conectado */
  toolCount: number
  /** Erro da conexão MCP, ou um código da própria integração (nodara-not-running...) */
  error?: string
}
