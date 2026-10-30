import type { ChatMessage, MessagePart, PieceKind, ToolPart } from '@shared/chat'

/**
 * File addresses rewritten for the mobile app.
 *
 * The phone does not know Electron's schemes — `orbit-media://` for images,
 * `orbit-audio://` for audio, `orbit-video://` for video, `orbit-artifact://`
 * for artifact and document. All of them are registered only in the main, so everything that
 * leaves here becomes a signed HTTP URL that the app reaches through the same host it
 * used to connect.
 *
 * A module separate from the server, and without Electron inside, because this is a seam
 * that breaks SILENTLY: a new part carrying an address of a new scheme and
 * nobody rewriting it is enough for it to vanish on the phone with no error on the desktop. The
 * token factory comes in as a parameter so the module stays testable.
 */

/** Only the ids we generate ourselves, and only image formats. */
const MEDIA_URL_RE = /^orbit-media:\/\/([a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif))$/
/** Same pattern as SAFE_AUDIO_ID (media.ts) — the id IS the file name. */
const AUDIO_URL_RE = /^orbit-audio:\/\/(aud_[a-z0-9]+\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac))$/
/** Same pattern as SAFE_VIDEO_ID (video/store.ts). */
const VIDEO_URL_RE = /^orbit-video:\/\/(vid_[a-z0-9]+)$/
/** Same pattern as SAFE_ARTIFACT_ID (media.ts): page, thumbnail, font and
 *  document renderings. */
const ARTIFACT_URL_RE = /^orbit-artifact:\/\/([a-zA-Z0-9_-]+\.(html|png|md|pdf|docx))$/

/** Scopes the phone fetches over HTTP (see companion-assets.ts). */
export type AssetScope =
  | 'media'
  | 'artifact'
  | 'audio'
  | 'video'
  | 'motion'
  | 'design'
  | 'slides'

/**
 * Tools that write a piece. What they return is not media: it is an interactive UI
 * that lives in a folder on the desktop, and the phone can only draw it after
 * knowing where it is — hence the URL traveling in the part, instead of being assembled there.
 */
const PIECE_TOOLS: Record<string, PieceKind> = {
  motion_write: 'motion',
  motion_edit: 'motion',
  design_write: 'design',
  design_edit: 'design',
  slides_write: 'slides',
  slides_edit: 'slides',
}

/** Piece id in the tool result — JSON when possible, regex when it comes loose. */
const PIECE_ID_RE = /\b((?:mv|dsg|sld)_[a-z0-9]+)\b/

function pieceIdOf(part: ToolPart): string | undefined {
  const output = part.output
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output) as { id?: unknown; piece?: { id?: unknown } }
    const candidate = parsed.piece?.id ?? parsed.id
    if (typeof candidate === 'string') return candidate
  } catch {
    // output in running text: falls into the regex below
  }
  return PIECE_ID_RE.exec(output)?.[1]
}

export type MediaTokenFactory = (scope: AssetScope, id: string) => string

/**
 * The signed HTTP URL, or null when it is not a media address (it stays as it is).
 *
 * Image keeps the historical route (`/api/media/<id>?t=`), which is already delivered and
 * working on the phone. The other scopes are born with the token in the PATH
 * (`/api/file/<scope>/<id>/<token>`), which is what makes a piece's `base.css`
 * and an artifact's thumbnail inherit the authorization without rewriting.
 */
export function rewriteMediaUrl(
  url: string | undefined,
  base: string,
  token: MediaTokenFactory,
): string | null {
  const id = url ? MEDIA_URL_RE.exec(url)?.[1] : undefined
  return id ? `${base}/api/media/${id}?t=${token('media', id)}` : null
}

/** URL of a file served by the given scope, with the token in the path. */
export function assetUrl(
  scope: AssetScope,
  id: string,
  base: string,
  token: MediaTokenFactory,
): string {
  return `${base}/api/file/${scope}/${encodeURIComponent(id)}/${token(scope, id)}`
}

function rewriteScopedUrl(
  url: string | undefined,
  scope: AssetScope,
  pattern: RegExp,
  base: string,
  token: MediaTokenFactory,
): string | null {
  const id = url ? pattern.exec(url)?.[1] : undefined
  return id ? assetUrl(scope, id, base, token) : null
}

/**
 * The parts that carry a file address, each one for a different reason.
 *
 * - `image` is the image the assistant put in the answer.
 * - `file` is the attachment chip: the `url` is an embedded thumbnail and the `mediaUrl`
 *   points to the original photo in the gallery — it is what the viewer zooms into.
 * - `audio` is the audio from `audio_generate`: the player plays it over HTTP.
 * - `video` is the video from `video_render`/`show_video`, which stays in the user's
 *   project and is served by Range.
 * - `artifact` is the `create_artifact` page; the `thumb` is the thumbnail that the
 *   gallery and the card use.
 * - `document` shows the HTML preview (`previewSrc`), not the Markdown — on the
 *   phone, it is what can be rendered.
 */
export function rewriteMediaPart(
  part: MessagePart,
  base: string,
  token: MediaTokenFactory,
): MessagePart | null {
  if (part.type === 'image') {
    const src = rewriteMediaUrl(part.src, base, token)
    return src ? { ...part, src } : null
  }
  if (part.type === 'file') {
    const mediaUrl = rewriteMediaUrl(part.mediaUrl, base, token)
    return mediaUrl ? { ...part, mediaUrl } : null
  }
  if (part.type === 'audio') {
    const src = rewriteScopedUrl(part.src, 'audio', AUDIO_URL_RE, base, token)
    return src ? { ...part, src } : null
  }
  if (part.type === 'video') {
    const src = rewriteScopedUrl(part.src, 'video', VIDEO_URL_RE, base, token)
    return src ? { ...part, src } : null
  }
  if (part.type === 'artifact') {
    const src = rewriteScopedUrl(part.src, 'artifact', ARTIFACT_URL_RE, base, token)
    if (!src) return null
    const thumb = rewriteScopedUrl(part.thumb, 'artifact', ARTIFACT_URL_RE, base, token)
    return { ...part, src, ...(thumb ? { thumb } : {}) }
  }
  if (part.type === 'document') {
    const previewSrc = rewriteScopedUrl(part.previewSrc, 'artifact', ARTIFACT_URL_RE, base, token)
    if (!previewSrc) return null
    const thumb = rewriteScopedUrl(part.thumb, 'artifact', ARTIFACT_URL_RE, base, token)
    return { ...part, previewSrc, ...(thumb ? { thumb } : {}) }
  }
  if (part.type === 'tool') {
    const kind = PIECE_TOOLS[part.tool]
    if (!kind) return null
    const id = pieceIdOf(part)
    if (!id) return null
    // Design has no single HTML: it is a canvas with several screens. The phone
    // receives the `canvas.json` and chooses which one to open; motion and slides draw
    // `index.html` directly (the companion resolves the scope's default entry).
    const url =
      kind === 'design'
        ? `${assetUrl('design', id, base, token)}/canvas.json`
        : assetUrl(kind, id, base, token)
    const title = typeof part.input?.title === 'string' ? part.input.title : part.title
    return { ...part, piece: { kind, id, url, ...(title ? { title } : {}) } }
  }
  return null
}

/** null when nothing changed — whoever calls reuses the original object. */
export function rewriteMessage(
  msg: ChatMessage,
  base: string,
  token: MediaTokenFactory,
): ChatMessage | null {
  let changed = false
  const parts = msg.parts.map((p) => {
    const rewritten = rewriteMediaPart(p, base, token)
    if (rewritten) {
      changed = true
      return rewritten
    }
    return p
  })
  return changed ? { ...msg, parts } : null
}

export function rewriteMessages(
  msgs: ChatMessage[],
  base: string,
  token: MediaTokenFactory,
): ChatMessage[] | null {
  let changed = false
  const out = msgs.map((m) => {
    const rewritten = rewriteMessage(m, base, token)
    if (rewritten) {
      changed = true
      return rewritten
    }
    return m
  })
  return changed ? out : null
}
