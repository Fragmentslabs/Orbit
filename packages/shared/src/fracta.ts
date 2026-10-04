/**
 * Fracta: integração oficial (bancos de dados via MCP).
 * O estado cruza duas pontas — o app Fracta rodando na máquina e o servidor
 * MCP "Fracta" registrado e conectado no Orbit.
 */

export type FractaState =
  /** Sem mcp.json na pasta de dados do Fracta: o Fracta nunca rodou nesta máquina */
  | 'not-installed'
  /** mcp.json existe, mas o backend do Fracta não responde (app fechado) */
  | 'stopped'
  /** Servidor MCP desligado em Fracta → Configurações → Agentes (MCP) */
  | 'disabled'
  /** Fracta no ar, mas ainda sem servidor MCP registrado no Orbit */
  | 'installed'
  /** Registrado no Orbit, porém a conexão MCP falhou (token novo, porta trocada...) */
  | 'error'
  /** Conectado: as tools estão no toolset do agente */
  | 'connected'

export interface FractaStatus {
  state: FractaState
  /** Existe entrada "Fracta" no mcp-config.json do Orbit */
  linked: boolean
  /** Credencial salva diverge da publicada pelo Fracta (token gerado de novo / porta trocada) */
  tokenStale: boolean
  mcpUrl?: string
  /** Quantidade de ferramentas expostas quando conectado */
  toolCount: number
  /** Erro da conexão MCP, ou um código da própria integração (fracta-not-running...) */
  error?: string
}
