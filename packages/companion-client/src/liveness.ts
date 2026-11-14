/**
 * Liveness of a socket: a periodic ping plus a deadline for ANY inbound message.
 *
 * A socket can say OPEN with nobody on the other side — a phone suspended in the
 * background, a laptop that slept, a Wi-Fi switch. Only traffic proves it is alive,
 * so after each ping the peer has `pongTimeoutMs` to send anything (pong, response
 * or event); without it the socket is declared dead and the owner reconnects.
 */

export interface LivenessOptions {
  intervalMs: number
  pongTimeoutMs: number
  /** Writes a ping to the socket. Returns false when the socket cannot take it. */
  sendPing: () => boolean
  /** No answer in time (or the ping could not be sent). */
  onDead: () => void
}

export class Liveness {
  private interval: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private lastPing = 0
  /** Last time ANY message arrived. */
  private lastInbound = 0

  constructor(private readonly o: LivenessOptions) {}

  /** Starts the periodic ping (call once the socket is authenticated). */
  start(): void {
    this.stop()
    this.interval = setInterval(() => this.probe(this.o.pongTimeoutMs), this.o.intervalMs)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.interval = null
    this.pongTimer = null
  }

  /** Any message from the other side counts as proof of life. */
  noteInbound(): void {
    this.lastInbound = Date.now()
  }

  /** A pong arrived: the round-trip latency in ms. */
  latency(): number {
    return Date.now() - this.lastPing
  }

  /** Pings now and waits `timeoutMs` for anything inbound; one probe at a time. */
  probe(timeoutMs: number): void {
    if (this.pongTimer) return
    const sentAt = Date.now()
    this.lastPing = sentAt
    let sent = false
    try {
      sent = this.o.sendPing()
    } catch {
      sent = false
    }
    if (!sent) {
      this.o.onDead()
      return
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null
      if (this.lastInbound < sentAt) this.o.onDead()
    }, timeoutMs)
  }
}
