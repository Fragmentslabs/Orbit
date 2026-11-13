import { protocol } from 'electron'
import { FRAGMENT_SCHEME } from '@shared/fragments'
import { injectArtifactChrome } from '../media'
import { SERVED_TYPES, isFragmentId, readFragmentAsset } from './fragment-store'
import { injectFragmentSdk } from './fragment-sdk'

/**
 * orbit-fragment://<id>/<path> — serves the `src/` folder of a fragment.
 *
 * The CSP is closed on purpose: scripts and styles only from the fragment itself (and
 * inline), no network (`connect-src 'self'` is just its own files), no CDN, no
 * external image or font, no frames, no forms. The only way out of the page is
 * `window.orbit`, which Orbit answers in the main process.
 *
 * The HTML also gets the `window.orbit` SDK and the Orbit design tokens (the same
 * variables the artifacts receive), so a fragment looks like it belongs to the app
 * and follows the light/dark theme.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ')

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export async function handleFragmentRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  const id = url.hostname
  if (!isFragmentId(id)) return notFound()
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  } catch {
    return notFound()
  }
  const asset = await readFragmentAsset(id, rel)
  if (!asset) return notFound()

  const type = SERVED_TYPES[asset.ext] ?? 'application/octet-stream'
  const body: BodyInit =
    asset.ext === 'html'
      ? injectArtifactChrome(injectFragmentSdk(asset.data.toString('utf8')))
      : new Uint8Array(asset.data)
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      // The files are rewritten in place while the agent edits: no cache.
      'Cache-Control': 'no-store',
      // The page lives in its own origin (orbit-fragment://<id>): its module scripts need CORS.
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/** Registers the scheme (call after app.whenReady). */
export function registerFragmentProtocol(): void {
  protocol.handle(FRAGMENT_SCHEME, handleFragmentRequest)
}
