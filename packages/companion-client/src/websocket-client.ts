/**
 * Cliente WebSocket para comunicação com o Orbit Desktop.
 *
 * Encapsula: autenticação via PIN, request/response com correlação de ID,
 * subscrição a eventos, heartbeat, reconexão com backoff exponencial
 * e queue de requests durante desconexão.
 */

import {
  type CompanionRequest,
  type CompanionEvent,
  type WsMessage,
  type ApiResponse,
  type AuthOkResponse,
  type AuthRequest,
  newMessageId,
} from '@orbit/shared'
import type { ConnectionConfig, ConnectionState, ConnectionErrorReason } from './types'

// ─── Event Handlers ──────────────────────────────────────────────────────────

type EventHandler = (event: CompanionEvent) => void
type StateChangeHandler = (state: ConnectionState) => void

// ─── Constants ───────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 15_000
/** Sem nenhuma mensagem do desktop por este tempo depois de um ping, o socket
 *  é dado como morto. No celular isso é comum: o iOS suspende o app em segundo
 *  plano, a rede troca de Wi-Fi, e o socket volta com readyState OPEN mas sem
 *  ninguém do outro lado — a UI dizia "conectado" e tudo que se mandava sumia. */
const PONG_TIMEOUT = 8_000
/** Ao voltar do segundo plano a checagem precisa ser rápida: a pessoa já está
 *  com o dedo no botão de enviar. */
const ALIVE_CHECK_TIMEOUT = 4_000
const RECONNECT_BASE_DELAY = 1_000
const RECONNECT_MAX_DELAY = 30_000
const RECONNECT_MAX_ATTEMPTS = 5
const REQUEST_TIMEOUT = 15_000

/**
 * Normaliza o `reason` do auth:error. O desktop pode ser mais novo que o app e
 * mandar um motivo que este cliente ainda não conhece — nesse caso vira
 * 'unknown' (com o valor cru preservado em `error` para diagnóstico).
 */
function authErrorReason(reason: unknown): ConnectionErrorReason {
  return reason === 'invalid_pin' || reason === 'already_paired' || reason === 'rate_limited'
    ? reason
    : 'unknown'
}

// ─── CompanionWebSocket ──────────────────────────────────────────────────────

export class CompanionWebSocket {
  private ws: WebSocket | null = null
  private config: ConnectionConfig | null = null
  private state: ConnectionState = { status: 'disconnected' }
  private eventHandlers = new Map<string, Set<EventHandler>>()
  private stateHandlers = new Set<StateChangeHandler>()
  private pendingRequests = new Map<
    string,
    { resolve: (v: ApiResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private queuedRequests: {
    msg: WsMessage
    resolve: (v: ApiResponse) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private shouldReconnect = false
  private lastPing = 0
  /** Última vez que QUALQUER mensagem chegou do desktop (pong, resposta, evento). */
  private lastInbound = 0
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  /** disconnect() explícito: o checkAlive não pode ressuscitar a conexão. */
  private closedByUser = false

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Conecta ao desktop. */
  connect(config: ConnectionConfig): void {
    this.config = config
    this.shouldReconnect = true
    this.closedByUser = false
    this.reconnectAttempt = 0
    this.setState({ reconnectAttempt: 0 })

    // Se já existe um socket (reconexão sem disconnect() explícito — ex.: a
    // tela de conexão chamando connect() de novo), fecha o anterior ANTES de
    // abrir outro. Sem isso cada connect() vazava uma conexão no servidor,
    // que acumulava o mesmo device N vezes na lista de conectados.
    if (this.ws) {
      const old = this.ws
      this.ws = null
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) {
        try {
          old.close()
        } catch { /* ignore */ }
      }
    }

    this.open()
  }

  /** Fecha a conexão (sem reconexão). */
  disconnect(): void {
    this.shouldReconnect = false
    this.closedByUser = true
    this.cleanup()
    this.setState({ status: 'disconnected' })
  }

  /** Envia um request e espera a resposta correlacionada. */
  send(request: CompanionRequest): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const id = newMessageId()
      const msg: WsMessage = { id, payload: request }

      if (this.state.status !== 'connected') {
        // Queue para enviar ao reconectar — com prazo. Sem ele a promise
        // ficava pendurada até a próxima conexão, e um "criar chat" + "enviar"
        // de minutos atrás disparava de repente, criando conversa e mandando
        // mensagem quando a pessoa já estava em outro chat.
        const entry = {
          msg,
          resolve,
          reject,
          timer: setTimeout(() => {
            this.queuedRequests = this.queuedRequests.filter((q) => q !== entry)
            reject(new Error(`Request ${request.type} timed out (offline)`))
          }, REQUEST_TIMEOUT),
        }
        this.queuedRequests.push(entry)
        return
      }

      this.sendWithCorrelation(id, msg, resolve, reject)
    })
  }

  /** Subscreve a um tipo de evento do servidor. */
  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set())
    }
    this.eventHandlers.get(eventType)!.add(handler)

    return () => {
      this.eventHandlers.get(eventType)?.delete(handler)
    }
  }

  /** Escuta mudanças de estado da conexão. */
  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler)
    return () => {
      this.stateHandlers.delete(handler)
    }
  }

  /**
   * Confere se o socket ainda tem alguém do outro lado — chamar quando o app
   * volta ao primeiro plano. Conectado: manda um ping e, sem resposta em
   * poucos segundos, derruba e reconecta. Desistiu de reconectar (esgotou as
   * tentativas enquanto o app estava parado): recomeça do zero.
   */
  checkAlive(): void {
    if (!this.config || this.closedByUser) return
    if (this.state.status === 'connected') {
      this.ping(ALIVE_CHECK_TIMEOUT)
      return
    }
    if (this.state.status === 'disconnected' && this.state.errorReason !== 'invalid_pin') {
      this.shouldReconnect = true
      this.reconnectAttempt = 0
      this.cleanup()
      this.open()
    }
  }

  /** Estado atual da conexão. */
  getState(): Readonly<ConnectionState> {
    return this.state
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private open(): void {
    if (!this.config) return

    this.setState({ status: 'connecting' })
    const { host, port } = this.config
    const url = `ws://${host}:${port}`

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      this.setState({ status: 'disconnected', errorReason: 'socket_error', error: String(err) })
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0
      this.authenticate()
    }

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data)
    }

    this.ws.onclose = (event) => {
      this.cleanup()
      if (this.shouldReconnect) {
        this.scheduleReconnect()
      } else {
        this.setState({ status: 'disconnected' })
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  private authenticate(): void {
    if (!this.config) return

    this.setState({ status: 'authenticating' })
    const authRequest: AuthRequest = {
      type: 'auth',
      pin: this.config.pin || undefined,
      token: this.config.token,
      deviceName: this.config.deviceName,
    }

    const id = newMessageId()
    const msg: WsMessage = { id, payload: authRequest }

    // Auth não usa sendWithCorrelation — tratamos direto
    this.ws?.send(JSON.stringify(msg))
  }

  private handleMessage(raw: string): void {
    let msg: WsMessage
    try {
      msg = JSON.parse(raw) as WsMessage
    } catch {
      return
    }

    this.lastInbound = Date.now()
    const { payload } = msg

    // Auth responses
    if (payload.type === 'auth:ok') {
      const ok = payload as AuthOkResponse
      // Guarda o token na config atual — reconexões (backoff) já usam token
      if (ok.deviceToken && this.config) {
        this.config = { ...this.config, token: ok.deviceToken }
      }
      this.setState({
        status: 'connected',
        serverVersion: ok.serverVersion,
        deviceName: ok.deviceName,
        deviceToken: ok.deviceToken,
      })
      this.startHeartbeat()
      this.flushQueue()
      return
    }

    if (payload.type === 'auth:error') {
      const reason = authErrorReason(payload.reason)
      this.setState({
        status: 'disconnected',
        errorReason: reason,
        // Motivo desconhecido: guarda o valor cru para diagnóstico (não é
        // exibível — a UI traduz pelo errorReason).
        error: reason === 'unknown' ? String(payload.reason) : undefined,
      })
      this.shouldReconnect = false
      this.cleanup()
      return
    }

    // Heartbeat pong — atualiza latência
    if ((payload as { type: string }).type === 'pong') {
      const now = Date.now()
      this.setState({ lastActivity: now, latency: now - this.lastPing })
      return
    }

    // API responses (correlated)
    if (payload.type === 'api:response') {
      const apiRes = payload as ApiResponse
      const pending = this.pendingRequests.get(apiRes.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(apiRes.requestId)
        pending.resolve(apiRes)
      }
      return
    }

    // Events — broadcast to subscribers
    this.emit(payload.type, payload as CompanionEvent)
  }

  private sendWithCorrelation(
    id: string,
    msg: WsMessage,
    resolve: (v: ApiResponse) => void,
    reject: (e: Error) => void,
  ): void {
    const timer = setTimeout(() => {
      this.pendingRequests.delete(id)
      reject(new Error(`Request ${msg.payload.type} timed out`))
    }, REQUEST_TIMEOUT)

    this.pendingRequests.set(id, { resolve, reject, timer })

    try {
      this.ws?.send(JSON.stringify(msg))
    } catch (err) {
      clearTimeout(timer)
      this.pendingRequests.delete(id)
      reject(new Error(`Failed to send: ${err}`))
    }
  }

  private flushQueue(): void {
    const queue = [...this.queuedRequests]
    this.queuedRequests = []

    for (const { msg, resolve, reject, timer } of queue) {
      clearTimeout(timer)
      if (this.state.status === 'connected') {
        this.sendWithCorrelation(msg.id, msg, resolve, reject)
      } else {
        reject(new Error('Connection lost before queue flush'))
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.ping(PONG_TIMEOUT), HEARTBEAT_INTERVAL)
  }

  /** Manda um ping e espera QUALQUER mensagem do desktop dentro do prazo
   *  (pong, resposta ou evento — tudo prova que o socket está vivo). */
  private ping(timeout: number): void {
    if (this.pongTimer) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.dropDeadSocket()
      return
    }
    const sentAt = Date.now()
    this.lastPing = sentAt
    try {
      ws.send(JSON.stringify({ id: '', payload: { type: 'ping' } }))
    } catch {
      this.dropDeadSocket()
      return
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null
      if (this.ws === ws && this.lastInbound < sentAt) this.dropDeadSocket()
    }, timeout)
  }

  /** Socket sem resposta: fecha (rejeitando o que estava pendente, em vez de
   *  deixar cada request morrer sozinho no timeout) e reconecta. */
  private dropDeadSocket(): void {
    if (!this.shouldReconnect) return
    this.cleanup()
    this.reconnectAttempt = 0
    this.setState({ status: 'connecting', reconnectAttempt: 0 })
    this.open()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.shouldReconnect = false
      // Só o código: o texto (traduzido, com o número de tentativas
      // interpolado) é montado pelo app.
      this.setState({
        status: 'disconnected',
        errorReason: 'connect_failed',
        error: undefined,
        reconnectAttempt: this.reconnectAttempt,
      })
      return
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY,
    )
    this.reconnectAttempt++
    this.setState({ reconnectAttempt: this.reconnectAttempt })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private cleanup(): void {
    this.stopHeartbeat()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connection closed'))
    }
    this.pendingRequests.clear()

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }

  private setState(next: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...next } as ConnectionState
    for (const handler of this.stateHandlers) {
      try {
        handler(this.state)
      } catch { /* swallow */ }
    }
  }

  private emit(type: string, event: CompanionEvent): void {
    const handlers = this.eventHandlers.get(type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event)
        } catch { /* swallow */ }
      }
    }
    // Also emit to wildcard subscribers
    const wildcard = this.eventHandlers.get('*')
    if (wildcard) {
      for (const handler of wildcard) {
        try {
          handler(event)
        } catch { /* swallow */ }
      }
    }
  }
}
