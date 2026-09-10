/**
 * Tipos internos do companion-client.
 * Re-exporta tipos de @orbit/shared e adiciona configurações de conexão.
 */

import type { AuthRejectReason } from '@orbit/shared'

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

/**
 * Motivo estruturado da falha de conexão.
 *
 * Os três primeiros vêm do `auth:error` do desktop (pareamento); os demais são
 * falhas do próprio cliente. O texto exibido é responsabilidade do app (i18n) —
 * este pacote só transporta o código.
 */
export type ConnectionErrorReason =
  | AuthRejectReason
  /** Esgotou as tentativas de reconexão (o desktop provavelmente está fechado). */
  | 'connect_failed'
  /** O socket não chegou a abrir (endereço/porta inválidos, WebSocket indisponível). */
  | 'socket_error'
  /** Falha que o app não sabe nomear (ex.: desktop mais novo mandou um motivo novo). */
  | 'unknown'

/** Estado da conexão WebSocket. */
export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'authenticating' | 'connected'
  /** Código do motivo da falha — é o que a UI deve traduzir. Presente em
   *  qualquer estado de falha. */
  errorReason?: ConnectionErrorReason
  /** Detalhe técnico cru (texto de exceção do runtime). Não exibir direto: só
   *  serve de diagnóstico quando `errorReason` é 'socket_error'/'unknown'. */
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
