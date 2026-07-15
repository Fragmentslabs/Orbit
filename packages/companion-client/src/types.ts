/**
 * Tipos internos do companion-client.
 * Re-exporta tipos de @orbit/shared e adiciona configurações de conexão.
 */

export type { ConnectionConfig, ConnectionState }

/** Configuração necessária para conectar ao desktop. */
interface ConnectionConfig {
  host: string
  port: number
  pin: string
  /** Nome do device (para exibição no desktop). */
  deviceName?: string
}

/** Estado da conexão WebSocket. */
interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'authenticating' | 'connected'
  error?: string
  /** Versão do servidor reportada no handshake. */
  serverVersion?: string
  /** Nome do desktop conectado. */
  deviceName?: string
  /** Timestamp da última atividade (heartbeat). */
  lastActivity?: number
  /** Latência estimada em ms. */
  latency?: number
}
