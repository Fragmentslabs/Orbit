import { mediaKind, type MediaEntry, type MediaKind } from '@orbit/shared'

/**
 * The phone gallery shows EVERYTHING the desktop produces, and each type asks for a
 * different treatment: only the image has a thumbnail (the <Image> handles it), audio and
 * video open in a player, and artifact/document/piece are PAGES (WebView). In the
 * tile, none of them has anything to draw — it becomes a card with icon + title, which
 * was what was missing when everything was rendered as <Image> and broke.
 *
 * The `url` of each entry already comes ready from the desktop (`GET /api/media`): each type
 * with the token of its scope in `/api/file/<scope>/<id>/<token>`. Here no
 * URL is assembled — it is only decided HOW to show what came.
 */

/** The order of the type filter chips — same as the desktop, media first. */
export const KIND_ORDER: readonly MediaKind[] = [
  'image',
  'artifact',
  'document',
  'video',
  'audio',
  'motion',
  'design',
  'slides',
]

/** The type of the entry (an old record has no `kind` = image). */
export function kindOf(entry: MediaEntry): MediaKind {
  return mediaKind(entry)
}

/**
 * Key of the type label, for the tile card and for the filter chip. It is the
 * key and not the text because this module does not call hooks: whoever renders resolves it
 * with `t(KIND_KEY[kind])`.
 */
export const KIND_KEY: Record<MediaKind, string> = {
  image: 'media.kind.image',
  artifact: 'media.kind.artifact',
  document: 'media.kind.document',
  video: 'media.kind.video',
  audio: 'media.kind.audio',
  motion: 'media.kind.motion',
  design: 'media.kind.design',
  slides: 'media.kind.slides',
}

/** Title of the item: the label of the record or, without one, the file name. */
export function entryTitle(entry: MediaEntry): string {
  const name = entry.name?.trim()
  return name && name.length > 0 ? name : entry.id
}

/**
 * The entry has somewhere to open. False when the piece left the desktop registry
 * (the folder vanished, the registry was cleaned): the tile stays in the gallery — the item
 * exists in the index — but there is no document to load.
 */
export function canOpen(entry: MediaEntry): boolean {
  return typeof entry.url === 'string' && entry.url.length > 0
}
