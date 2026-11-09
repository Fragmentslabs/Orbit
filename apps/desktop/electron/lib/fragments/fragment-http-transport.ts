import dns from 'node:dns'
import https from 'node:https'
import { isBlockedAddress } from './fragment-address'

/**
 * The one place a fragment's request actually leaves the machine: Node's https client in
 * the main process — no Chromium session, so no cookies, no stored logins, no proxy
 * credentials of the person. The address is checked at connect time (not only before), so a
 * host that resolves to a private address, or flips to one between check and connect, is
 * refused.
 */

export interface TransportRequest {
  url: URL
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  maxBytes: number
}

export interface TransportResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  /** The body was longer than `maxBytes` and was cut. */
  truncated: boolean
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>

/** Collects at most `max` bytes; past that it stops reading and destroys the source. */
export async function readCapped(
  stream: AsyncIterable<Buffer | string> & { destroy?: () => void },
  max: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const piece of stream) {
    const chunk = typeof piece === 'string' ? Buffer.from(piece) : piece
    if (size + chunk.length > max) {
      chunks.push(chunk.subarray(0, max - size))
      stream.destroy?.()
      return { body: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(chunk)
    size += chunk.length
  }
  return { body: Buffer.concat(chunks), truncated: false }
}

const guardedLookup: NonNullable<https.RequestOptions['lookup']> = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    const list = addresses as dns.LookupAddress[] | undefined
    if (error || !list || list.length === 0) return callback(error ?? new Error('host not found'), '', 4)
    if (list.some((a) => isBlockedAddress(a.address))) {
      return callback(new Error('host resolves to a private or local address'), '', 4)
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
    return callback(null, list[0].address, list[0].family)
  })
}

export const httpsTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        lookup: guardedLookup,
        agent: false,
        timeout: request.timeoutMs,
      },
      (res) => {
        readCapped(res, request.maxBytes).then(({ body, truncated }) => {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(res.headers)) {
            if (name === 'set-cookie' || value === undefined) continue
            headers[name] = Array.isArray(value) ? value.join(', ') : value
          }
          resolve({ status: res.statusCode ?? 0, headers, body, truncated })
        }, reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`timed out after ${Math.round(request.timeoutMs / 1000)}s`)))
    req.on('error', reject)
    req.end(request.body)
  })
