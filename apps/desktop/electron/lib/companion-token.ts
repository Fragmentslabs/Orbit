/**
 * Signed tokens for the files the mobile app downloads over HTTP.
 *
 * The phone does not have Electron's schemes (`orbit-media://`, `orbit-audio://`,
 * `orbit-video://`, `orbit-artifact://`, `orbit-motion://`…), so everything it
 * needs to see becomes a URL of the companion's server. And since `<Image>`,
 * `<video>` and the WebView do not reliably send the `Authorization` header,
 * the authorization goes in the URL's PATH — not in the query: a motion piece
 * references `base.css`, `clip.mp4` and the like by relative path, and a token in the
 * query would not accompany those requests (the relative one resolves against the path, and
 * not against the document's query). With the token as a SEGMENT of the path,
 * `/api/file/motion/mv_x/<token>/base.css` works without rewriting anything inside
 * the piece.
 *
 * A module separate from the server so the secret and the signature have a single owner:
 * whoever signs (companion-server, when rewriting the parts) and whoever validates (the
 * HTTP server) have to agree exactly.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * 24h: long enough for the app's cache to survive scrolling, re-rendering and
 * reopening the conversation without a token refetch; short enough for a leaked
 * URL not to count forever.
 */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Secret persisted in orbit-data/media-secret — signed tokens survive
 * desktop restarts (otherwise every image already delivered to the mobile would become 401
 * when the app restarts). Synchronous read: it has to be ready before the first token.
 */
function loadSecret(): string {
  const file = path.join(app.getPath('userData'), 'orbit-data', 'media-secret')
  try {
    const existing = fsSync.readFileSync(file, 'utf8').trim()
    if (existing.length === 64) return existing
  } catch {
    /* does not exist yet — generates it below */
  }
  const secret = randomBytes(32).toString('hex')
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true })
    fsSync.writeFileSync(file, secret, { mode: 0o600 })
  } catch {
    console.warn('[CompanionToken] could not persist the secret — tokens do not survive a restart')
  }
  return secret
}

const secret = loadSecret()

/**
 * Each scope has its root and its resolver on the desktop (see
 * companion-assets.ts). The token counts for the scope+id pair: a
 * `video/vid_x` token does not open `artifact/art_y.html`.
 */
export type AssetScope =
  | 'media'
  | 'artifact'
  | 'audio'
  | 'video'
  | 'motion'
  | 'design'
  | 'slides'
  /** A file of the font library (`<hash>.woff2`): `orbit-font://` does not
   *  exist on the phone, and it is what the `<style>` of `font_use` references. */
  | 'font'

const SCOPES: readonly AssetScope[] = [
  'media',
  'artifact',
  'audio',
  'video',
  'motion',
  'design',
  'slides',
  'font',
]

export function isAssetScope(value: string): value is AssetScope {
  return (SCOPES as readonly string[]).includes(value)
}

/**
 * `media` keeps the historical signature (only the id, without a scope).
 *
 * It is not laziness: that format was already delivered to connected apps and the secret
 * survives a restart, so changing it would invalidate every image already on screen until the
 * next message sync — a bug that would only show up on the phone of someone
 * already connected. The new scopes are born with the correct format.
 */
function signPayload(scope: AssetScope, id: string, exp: number): string {
  const payload = scope === 'media' ? `${id}:${exp}` : `${scope}:${id}:${exp}`
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function createAssetToken(scope: AssetScope, id: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  return `${exp}.${signPayload(scope, id, exp)}`
}

export function validateAssetToken(
  scope: AssetScope,
  id: string,
  token: string | null,
): boolean {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const exp = Number(token.slice(0, dot))
  const sig = token.slice(dot + 1)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expected = signPayload(scope, id, exp)
  if (expected.length !== sig.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
}
