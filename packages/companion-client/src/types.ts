/**
 * Tipos internos do companion-client.
 * Re-exporta tipos de @orbit/shared e adiciona configurações de conexão.
 */

/** Configuração necessária para conectar ao desktop. */
export interface ConnectionConfig {
  host: string
  port: number
  /** PIN de pareamento — necessário apenas no primeiro pareamento. */
  pin: string
  /** Token persistente emitido pelo desktop no primeiro pareamento —
   *  quando presente, autentica sem PIN. */
  token?: string
  /** Nome do device (para exibição no desktop). */
  deviceName?: string
}

/** Estado da conexão WebSocket. */
export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'authenticating' | 'connected'
  error?: string
  /** Versão do servidor reportada no handshake. */
  serverVersion?: string
  /** Nome do desktop conectado. */
  deviceName?: string
  /** Token persistente emitido/confirmado pelo desktop no auth:ok —
   *  o app deve salvar e reutilizar nas próximas conexões. */
  deviceToken?: string
  /** Timestamp da última atividade (heartbeat). */
  lastActivity?: number
  /** Latência estimada em ms. */
  latency?: number
  /** Tentativas de reconexão desde o último connect(). */
  reconnectAttempt?: number
}
