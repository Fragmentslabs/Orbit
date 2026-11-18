import { useEffect, useState } from 'react'

export type RemoteMarkdown =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; text: string }

type Settled = { key: string; text: string | null }

/**
 * Downloads a document's Markdown source from its signed companion URL.
 *
 * `revision` is part of the key: an `update_document` rewrites the file in place, so the same URL
 * has new content. `idle` means there is no source to read (an older desktop): the caller falls back
 * to the desktop's HTML preview.
 */
export function useRemoteMarkdown(url: string | undefined, revision?: number): RemoteMarkdown {
  const key = url ? `${url}#${revision ?? 0}` : ''
  const [settled, setSettled] = useState<Settled | null>(null)

  useEffect(() => {
    if (!url) return
    let alive = true
    fetch(url)
      .then((res) => (res.ok ? res.text() : null))
      .catch(() => null)
      .then((text) => {
        if (alive) setSettled({ key, text })
      })
    return () => {
      alive = false
    }
  }, [url, key])

  if (!url) return { status: 'idle' }
  if (!settled || settled.key !== key) return { status: 'loading' }
  return settled.text === null ? { status: 'error' } : { status: 'ready', text: settled.text }
}
