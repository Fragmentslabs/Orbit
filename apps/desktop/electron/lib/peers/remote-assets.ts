import https from 'node:https'
import { Readable } from 'node:stream'
import { pinnedClientTlsOptions } from './tls-options'
import { peerForAsset } from './remote-index'
import { peerRequest, peerTransport } from './peer-client'
import type { PropsFile } from '../video/motion-props'

/**
 * The file of another desktop, for this machine's scheme handlers.
 *
 * Each handler (orbit-media, orbit-motion, …) tries the local disk first; when the
 * id is not local and the index says which peer it came from, it asks here. The
 * request goes over HTTPS pinned to that peer's certificate, with our client
 * certificate and our device token — nothing signed travels in a URL, and the
 * renderer never sees a token.
 *
 * Range and If-None-Match pass through, so video seeks and the design ETag keep
 * working.
 */

const TIMEOUT_MS = 30_000

export type RemoteScope = 'media' | 'artifact' | 'audio' | 'video' | 'motion' | 'design' | 'slides'

/** Does this id belong to a paired peer that is still trusted? */
export function isRemoteAsset(id: string): boolean {
  const peerId = peerForAsset(id)
  return !!peerId && !!peerTransport(peerId)
}

/**
 * `relative` is the path inside the piece, still percent-encoded (`url.pathname`
 * without the leading `/`), the same contract the asset server expects.
 */
export function fetchRemoteAsset(scope: RemoteScope, id: string, relative: string, request?: Request): Promise<Response | null> {
  const peerId = peerForAsset(id)
  const transport = peerId ? peerTransport(peerId) : null
  if (!transport) return Promise.resolve(null)
  const rel = relative.replace(/^\/+/, '')
  const path = `/peer/file/${scope}/${encodeURIComponent(id)}${rel ? `/${rel}` : ''}`
  const headers: Record<string, string> = { Authorization: `Bearer ${transport.token}` }
  const range = request?.headers.get('range')
  if (range) headers.Range = range
  const etag = request?.headers.get('if-none-match')
  if (etag) headers['If-None-Match'] = etag
  const method = request?.method === 'HEAD' ? 'HEAD' : 'GET'

  return new Promise((resolve) => {
    const req = https.request(
      {
        host: transport.host,
        port: transport.port,
        path,
        method,
        headers,
        timeout: TIMEOUT_MS,
        ...pinnedClientTlsOptions(transport.identity, transport.cert),
      },
      (res) => {
        const out = new Headers()
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'cache-control']) {
          const value = res.headers[name]
          if (typeof value === 'string') out.set(name, value)
        }
        const status = res.statusCode ?? 502
        const noBody = method === 'HEAD' || status === 204 || status === 304
        if (noBody) res.resume()
        resolve(
          new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers: out }),
        )
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(new Response('peer unreachable', { status: 502 })))
    req.end()
  })
}

const propsCache = new Map<string, { at: number; value: Promise<PropsFile | null> }>()

/** props.json of a peer's composition (cached a few seconds: every page load asks). */
export function remoteMotionProps(id: string): Promise<PropsFile | null> {
  const peerId = peerForAsset(id)
  if (!peerId) return Promise.resolve(null)
  const hit = propsCache.get(id)
  if (hit && Date.now() - hit.at < 5000) return hit.value
  const value = peerRequest<PropsFile>(peerId, { type: 'piece:props', id }).catch(() => null)
  propsCache.set(id, { at: Date.now(), value })
  if (propsCache.size > 200) propsCache.delete(propsCache.keys().next().value as string)
  return value
}

/** The whole body as text (HTML that this machine injects its runtime into). */
export async function fetchRemoteText(scope: RemoteScope, id: string, relative: string): Promise<{ status: number; text: string; type: string } | null> {
  const res = await fetchRemoteAsset(scope, id, relative)
  if (!res) return null
  const text = res.ok ? await res.text() : ''
  return { status: res.status, text, type: res.headers.get('content-type') ?? 'text/html; charset=utf-8' }
}
