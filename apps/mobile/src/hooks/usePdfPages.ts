import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentPageImage, DocumentPagesView } from '@orbit/companion-client'

import { PDF_BATCH, PDF_FIND_PREFETCH, pagesToFetch } from '~/lib/document-pdf'
import { useConnectionStore } from '~/stores/connection-store'

interface PdfPagesState {
  total: number
  outline: DocumentPagesView['outline']
  pages: Record<number, DocumentPageImage>
  error: boolean
}

type Fetched = { failed: true } | { failed: false; data: DocumentPagesView; first: boolean }

const EMPTY: PdfPagesState = { total: 0, outline: [], pages: {}, error: false }

/**
 * Pages of a PDF source as the desktop draws them (images + positioned text), fetched a few at a time
 * as they scroll near. `start` is the first batch (the cited page); `request` asks for the batch around
 * a page, `prefetch` walks the first pages so a search has something to look through.
 */
export function usePdfPages({
  docId,
  sessionId,
  enabled,
  start,
}: {
  docId: string | null
  sessionId?: string
  enabled: boolean
  start: number
}) {
  const http = useConnectionStore((s) => s.http)
  const [state, setState] = useState<PdfPagesState>(EMPTY)
  const have = useRef<Record<number, true>>({})
  const asked = useRef<Record<number, true>>({})
  const totalRef = useRef(0)

  const apply = useCallback((result: Fetched | null) => {
    if (!result) return
    if (result.failed) return setState((prev) => ({ ...prev, error: true }))
    const { data, first } = result
    setState((prev) => ({
      total: data.total,
      outline: first ? data.outline : prev.outline,
      pages: { ...prev.pages, ...Object.fromEntries(data.pages.map((p) => [p.page, p])) },
      error: false,
    }))
  }, [])

  // The batch around `page`; `first` also brings the outline, once. It only fetches: the caller
  // applies the result, so no state is set from the body of an effect.
  const load = useCallback(
    async (page: number, first = false): Promise<Fetched | null> => {
      if (!http || !docId) return null
      const wanted = first
        ? [Math.max(1, page)]
        : pagesToFetch(page, totalRef.current, (n) => !!have.current[n] || !!asked.current[n])
      if (wanted.length === 0) return null
      for (const n of wanted) asked.current[n] = true
      const res = await http.getDocumentPages(docId, {
        sessionId,
        from: wanted[0],
        count: first ? PDF_BATCH : wanted.length,
        outline: first,
      })
      if (!res.ok || !res.data) {
        for (const n of wanted) delete asked.current[n]
        return first ? { failed: true } : null
      }
      const data = res.data
      totalRef.current = data.total
      for (const p of data.pages) have.current[p.page] = true
      return { failed: false, data, first }
    },
    [http, docId, sessionId],
  )

  useEffect(() => {
    if (!enabled) return
    let alive = true
    void load(start, true).then((result) => {
      if (alive) apply(result)
    })
    return () => {
      alive = false
    }
  }, [enabled, load, apply, start])

  const request = useCallback((page: number) => void load(page).then(apply), [load, apply])

  const prefetch = useCallback(async () => {
    for (let n = 1; n <= Math.min(PDF_FIND_PREFETCH, totalRef.current); n += PDF_BATCH) {
      apply(await load(n))
    }
  }, [load, apply])

  return { ...state, request, prefetch }
}
