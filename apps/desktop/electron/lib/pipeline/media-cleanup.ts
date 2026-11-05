import { deleteMedia, mediaIdFromUrl } from '../media'

/**
 * Images a pipeline task keeps in its text (screenshots the phases attached, or
 * pasted into the description). They live in the media store, referenced by
 * `orbit-media://` URLs; these helpers find them, free them and leave a
 * placeholder so the text still reads.
 */

const URL_RE = /orbit-media:\/\/[^\s)"'<>\]]+/g

export const IMAGE_REMOVED = '[image removed]'

export function mediaUrlsIn(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])]
}

/** Replaces the given URLs (all of them when omitted) with the placeholder. */
export function stripMediaUrls(text: string, urls?: string[]): string {
  const wanted = urls ? new Set(urls) : undefined
  return text.replace(URL_RE, (url) => (!wanted || wanted.has(url) ? IMAGE_REMOVED : url))
}

/** Deletes the stored files behind the URLs. Returns how many were removed. */
export async function deleteMediaUrls(urls: string[]): Promise<number> {
  let removed = 0
  for (const url of urls) {
    const id = mediaIdFromUrl(url)
    if (id && (await deleteMedia(id).catch(() => false))) removed++
  }
  return removed
}
