import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { SLIDES_SCHEME } from "@shared/media"
import { slidesApi } from "@/src/lib/ipc"

/** Marca das mensagens da ponte — a mesma de slides-runtime.ts. */
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
 * Caminho da entrada DENTRO da pasta registrada — o que a URL
 * `orbit-slides://<id>/<caminho-relativo>` serve (mesma regra do motion-tab).
 */
export function entryPath(entry: string): string {
  const cleaned = entry.replace(/\\/g, "/").replace(/^file:\/\//, "")
  const relative =
    /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("/") ? baseName(cleaned) : cleaned.replace(/^\.\//, "")
  return relative.split("/").map(encodeURIComponent).join("/")
}

/**
 * O palco de um deck: o iframe, a ponte e o slide em que ele está.
 *
 * Quem monta o 16:9, escala e obedece ao teclado é o runtime injetado no
 * `<head>` (electron/lib/slides/slides-runtime.ts). Este hook segura o que é do
 * app — qual slide está na tela, quando recarregar e o que fazer quando o
 * runtime pede tela cheia — para que a aba e o card do chat compartilhem o
 * mesmo comportamento sem duplicar a ponte.
 *
 * A ponte é postMessage com `source: "orbit-slides"`:
 *
 *   deck → app: ready (total, palco, títulos e notas), change (índice),
 *               error, request-fullscreen
 *   app → deck: go(index), next, prev
 *
 * O iframe roda em `sandbox="allow-scripts"` SEM `allow-same-origin` (origem
 * opaca): não dá para ler o DOM dele, e é por isso que a lista de slides e as
 * notas chegam pelo `ready` em vez de serem lidas daqui.
 *
 * Duas superfícies usam este hook, cada uma com o SEU iframe. O filtro
 * `event.source === iframe.contentWindow` é o que impede um palco de reagir ao
 * "change" do outro — sem ele, dois decks na mesma conversa trocariam de slide
 * juntos.
 */
export function useSlidesDeck({
  slidesId,
  entry,
  initialIndex = 0,
  onFullscreenRequest,
}: {
  slidesId?: string
  entry?: string
  /** Slide em que o palco abre (a tela cheia herda o slide do card). */
  initialIndex?: number
  /** O runtime pediu tela cheia (tecla F dentro do palco). */
  onFullscreenRequest?: () => void
}) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [deck, setDeck] = useState<DeckInfo | null>(null)
  const [index, setIndex] = useState(initialIndex)
  const [reloads, setReloads] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)

  /**
   * Slide a reenviar assim que o runtime disser "ready". Cobre duas coisas: a
   * entrada (a tela cheia herda o slide do card) e a recarga ao vivo, em que o
   * iframe remonta e o deck VOLTARIA ao slide 0 — o alvo é o do momento da
   * recarga. Esperar o "ready" é determinístico: um deck que demora a carregar
   * não volta mais para o primeiro slide.
   */
  const restoreRef = useRef(initialIndex)
  useEffect(() => {
    restoreRef.current = initialIndex
  }, [initialIndex])

  /** O índice mais recente, para o watcher (que não pode reassinar a cada troca). */
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

  /** Comando app → deck. Sem janela montada, não há para quem mandar. */
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

  // Outro deck no mesmo palco: começa do zero, sem herdar índice nem erro.
  useEffect(() => {
    restoreRef.current = initialIndex
    setDeck(null)
    setIndex(initialIndex)
    setFailed(null)
    // `initialIndex` de propósito fora: trocar o slide inicial do MESMO deck
    // (a tela cheia do chat) não pode remontar o palco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slidesId])

  // ---------------------------------------------------------------- ponte
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow
      // A origem do iframe é opaca (sandbox sem allow-same-origin): quem diz
      // que a mensagem é DESTE iframe é a janela de origem, não a origem.
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
        // O runtime é a fonte da verdade do índice: clique no palco e tecla
        // dentro do iframe também mudam de slide, não só o nosso `go`.
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

  // O agente reescreveu o arquivo (fs.watch do main): recarrega voltando ao
  // MESMO slide, que é o que deixa comparar o antes e o depois do ajuste.
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

  // Sem "ready" a tempo, a página não vai responder: pergunta ao scheme o que
  // houve (a mesma URL, por fetch — o scheme aceita CORS) em vez de deixar o
  // palco girando para sempre.
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
