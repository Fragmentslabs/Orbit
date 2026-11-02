/**
 * Can this URL be fetched to rebuild the file? Persisted attachments that were turned into a
 * conversation source (pasted text, .md, .txt, PDF…) keep NO bytes: `url` is "". `fetch("")`
 * does not fail — it resolves to the page that is running, so the "file" that came back was
 * the app's own index.html under the name of the attachment (and was then resent as such).
 */
export function isFetchableAttachmentUrl(url: string | undefined): url is string {
  return !!url && /^(data:|blob:|https?:|file:|orbit-[a-z]+:)/i.test(url)
}
