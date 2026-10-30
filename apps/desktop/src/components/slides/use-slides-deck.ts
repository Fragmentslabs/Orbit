import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { SLIDES_SCHEME } from "@shared/media"
import { slidesApi } from "@/src/lib/ipc"

/** Mark of the bridge messages — the same as slides-runtime.ts. */
const SLIDES_SOURCE = "orbit-slides"

export interface SlideInfo {
  title: string
  notes: string
}

export interface DeckInfo {
  total: number
  width: number
  height: number
  slides: SlideInfo[]
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * Path of the entry INSIDE the registered folder — what the URL
 * `orbit-slides://<id>/<relative-path>` serves (same rule as motion-tab).
 */
export function entryPath(entry: string): string {
  const cleaned = entry.replace(/\\/g, "/").replace(/^file:\/\//, "")
  const relative =
    /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("/") ? baseName(cleaned) : cleaned.replace(/^\.\//, "")
  return relative.split("/").map(encodeURIComponent).join("/")
}

/**
 * The stage of a deck: the iframe, the bridge and the slide it is on.
 *
 * What builds the 16:9, scales and obeys the keyboard is the runtime injected into the
 * `<head>` (electron/lib/slides/slides-runtime.ts). This hook holds what belongs to the
 * app — which slide is on screen, when to reload and what to do when the
 * runtime asks for fullscreen — so that the tab and the chat card share the
 * same behavior without duplicating the bridge.
 *
 * The bridge is postMessage with `source: "orbit-slides"`:
 *
 *   deck → app: ready (total, stage, titles and notes), change (index),
 *               error, request-fullscreen
 *   app → deck: go(index), next, prev
 *
 * The iframe runs in `sandbox="allow-scripts"` WITHOUT `allow-same-origin` (opaque
 * origin): there is no way to read its DOM, and that is why the slide list and the
 * notes arrive through `ready` instead of being read from here.
 *
 * Two surfaces use this hook, each one with ITS OWN iframe. The
 * `event.source === iframe.contentWindow` filter is what prevents one stage from reacting to
 * the other's "change" — without it, two decks in the same conversation would switch slides
 * together.
 */
export function useSlidesDeck({
  slidesId,
  entry,
  initialIndex = 0,
  onFullscreenRequest,
}: {
  slidesId?: string
  entry?: string
  /** Slide the stage opens on (fullscreen inherits the card's slide). */
  initialIndex?: number
  /** The runtime asked for fullscreen (F key inside the stage). */
  onFullscreenRequest?: () => void
}) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [deck, setDeck] = useState<DeckInfo | null>(null)
  const [index, setIndex] = useState(initialIndex)
  const [reloads, setReloads] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)

  /**
   * Slide to resend as soon as the runtime says "ready". It covers two things: the
   * entry (fullscreen inherits the card's slide) and the live reload, in which the
   * iframe remounts and the deck WOULD GO BACK to slide 0 — the target is the one of the moment of the
   * reload. Waiting for "ready" is deterministic: a deck that takes long to load
   * does not go back to the first slide anymore.
   */
  const restoreRef = useRef(initialIndex)
  useEffect(() => {
    restoreRef.current = initialIndex
  }, [initialIndex])

  /** The most recent index, for the watcher (which cannot re-subscribe on every switch). */
  const indexRef = useRef(index)
  useEffect(() => {
    indexRef.current = index
  }, [index])

  const fullscreenRef = useRef(onFullscreenRequest)
  useEffect(() => {
    fullscreenRef.current = onFullscreenRequest
  }, [onFullscreenRequest])

  const src = useMemo(
    () => (slidesId && entry ? `${SLIDES_SCHEME}://${slidesId}/${entryPath(entry)}?r=${reloads}` : ""),
    [slidesId, entry, reloads],
  )

  /** App → deck command. With no window mounted, there is no one to send it to. */
  const post = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ source: SLIDES_SOURCE, ...message }, "*")
  }, [])

  const total = deck?.total ?? 0

  const go = useCallback(
    (target: number) => {
      if (total <= 0) return
      const next = Math.max(0, Math.min(total - 1, target))
      setIndex(next)
      post({ type: "go", index: next })
    },
    [post, total],
  )

  const reload = useCallback(() => {
    restoreRef.current = indexRef.current
    setDeck(null)
    setFailed(null)
    setReloads((n) => n + 1)
  }, [])

  const next = useCallback(() => go(indexRef.current + 1), [go])
  const prev = useCallback(() => go(indexRef.current - 1), [go])

  // Another deck on the same stage: it starts from zero, without inheriting index or error.
  useEffect(() => {
    restoreRef.current = initialIndex
    setDeck(null)
    setIndex(initialIndex)
    setFailed(null)
    // `initialIndex` out on purpose: swapping the initial slide of the SAME deck
    // (the chat fullscreen) cannot remount the stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slidesId])

  // --------------------------------------------------------------- bridge
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow
      // The iframe origin is opaque (sandbox without allow-same-origin): what says
      // that the message is from THIS iframe is the source window, not the origin.
      if (!win || event.source !== win) return
      const data = event.data as Record<string, unknown> | null
      if (!data || data.source !== SLIDES_SOURCE) return
      if (data.type === "ready") {
        setFailed(null)
        setDeck({
          total: Number(data.total) || 0,
          width: Number(data.width) || 0,
          height: Number(data.height) || 0,
          slides: Array.isArray(data.slides) ? (data.slides as SlideInfo[]) : [],
        })
        const target = restoreRef.current
        restoreRef.current = 0
        if (target > 0) {
          setIndex(target)
          win.postMessage({ source: SLIDES_SOURCE, type: "go", index: target }, "*")
        } else {
          setIndex(0)
        }
      } else if (data.type === "change") {
        // The runtime is the source of truth of the index: a click on the stage and a key
        // inside the iframe also switch slides, not only our `go`.
        setIndex(Number(data.index) || 0)
      } else if (data.type === "error") {
        setFailed(String(data.message ?? "unknown"))
      } else if (data.type === "request-fullscreen") {
        fullscreenRef.current?.()
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  // The agent rewrote the file (main fs.watch): it reloads going back to the
  // SAME slide, which is what allows comparing the before and the after of the adjustment.
  useEffect(() => {
    if (!slidesId) return
    return slidesApi.onChanged((payload) => {
      if (payload.id !== slidesId) return
      restoreRef.current = indexRef.current
      setDeck(null)
      setFailed(null)
      setReloads((n) => n + 1)
    })
  }, [slidesId])

  // Without "ready" in time, the page is not going to answer: it asks the scheme what
  // happened (the same URL, through fetch — the scheme accepts CORS) instead of leaving the
  // stage spinning forever.
  useEffect(() => {
    if (!src || deck) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled) return
      void fetch(src)
        .then(async (res) => {
          if (cancelled || res.ok) return
          const text = (await res.text().catch(() => "")).trim().slice(0, 120)
          setFailed(t("slides.loadFailedHttp", { status: res.status, text: text || res.statusText }))
        })
        .catch((err: unknown) => {
          if (!cancelled) setFailed(err instanceof Error ? err.message : String(err))
        })
    }, 6000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [src, deck, t])

  return {
    iframeRef,
    src,
    deck,
    index,
    total,
    current: deck?.slides[index],
    loading: !deck && !failed,
    failed,
    go,
    next,
    prev,
    reload,
  }
}
