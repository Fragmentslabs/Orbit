import https from 'node:https'
import { Readable } from 'node:stream'
import type { PeerIdentity } from './identity'
import { pinnedClientTlsOptions } from './tls-options'

/**
 * `fetch` over the peer's mutual-TLS server, pinning the certificate it paired
 * with and presenting our client certificate. It is what lets the desktop reuse
 * the same `CompanionHttp` the phone uses: the REST surface is the same, only the
 * transport differs (HTTPS on the peer port instead of HTTP on port + 1).
 */
export function peerFetch(identity: PeerIdentity, cert: string): typeof fetch {
  const pinned = pinnedClientTlsOptions(identity, cert)
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      let url: URL
      try {
        url = new URL(raw)
      } catch (err) {
        reject(err)
        return
      }
      if (url.protocol !== 'https:') {
        reject(new Error('peer_http_requires_https'))
        return
      }

      const headers = new Headers(init?.headers)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = init?.body
      let payload: Buffer | null = null
      if (typeof body === 'string') payload = Buffer.from(body)
      else if (body instanceof Uint8Array) payload = Buffer.from(body)
      else if (body instanceof ArrayBuffer) payload = Buffer.from(body)
      if (payload) headers.set('Content-Length', String(payload.length))

      const req = https.request(
        {
          host: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method,
          headers: Object.fromEntries(headers.entries()),
          timeout: 30_000,
          ...pinned,
        },
        (res) => {
          const out = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) for (const v of value) out.append(name, v)
            else if (value !== undefined) out.set(name, value)
          }
          const status = res.statusCode ?? 502
          const noBody = method === 'HEAD' || status === 204 || status === 304
          if (noBody) {
            res.resume()
            resolve(new Response(null, { status, headers: out }))
            return
          }
          resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream, { status, headers: out }))
        },
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })) as typeof fetch
}
