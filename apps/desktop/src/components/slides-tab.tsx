import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  Presentation,
  RotateCw,
  StickyNote,
} from "lucide-react"
import { SLIDES_SCHEME } from "@shared/media"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconAction } from "@/src/components/ai/artifact-part"
import { slidesApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"

/** Marca das mensagens da ponte — a mesma de slides-runtime.ts. */
const SLIDES_SOURCE = "orbit-slides"

interface SlideInfo {
  title: string
  notes: string
}

interface DeckInfo {
  total: number
  width: number
  height: number
  slides: SlideInfo[]
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * Botão de alternância da barra (lista, notas). O IconAction das outras abas
 * não tem estado ativo — aqui o ícone precisa dizer se o painel está aberto.
 */
function ToggleAction({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof List
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-6", active ? "text-foreground" : "text-muted-foreground")}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <Icon className="size-3.5" />
    </Button>
  )
}

/**
 * Caminho da entrada DENTRO da pasta registrada — o que a URL
 * `orbit-slides://<id>/<caminho-relativo>` serve (mesma regra do motion-tab).
 */
function entryPath(entry: string): string {
  const cleaned = entry.replace(/\\/g, "/").replace(/^file:\/\//, "")
  const relative = /^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith("/") ? baseName(cleaned) : cleaned.replace(/^\.\//, "")
  return relative.split("/").map(encodeURIComponent).join("/")
}

/**
 * O palco de um deck de slides na aba do painel direito.
 *
 * O iframe carrega a PASTA registrada por `orbit-slides://<id>/<entrada>`; quem
 * monta o 16:9, escala e obedece ao teclado é o runtime injetado no `<head>`
 * (electron/lib/slides/slides-runtime.ts). Aqui ficam as rédeas que são do app:
 * a lista de slides, as notas do apresentador, o contador e a tela cheia.
 *
 * A ponte é postMessage com `source: "orbit-slides"`:
 *
 *   deck → painel: ready (total, palco, títulos e notas), change (índice),
 *                  error, request-fullscreen
 *   painel → deck: go(index), next, prev
 *
 * O iframe roda em `sandbox="allow-scripts"` SEM `allow-same-origin` (origem
 * opaca): não dá para ler o DOM dele, e é por isso que a lista de slides e as
 * notas chegam pelo `ready` em vez de serem lidas daqui.
 */
export function SlidesTab({
  slidesId,
  entry,
  title,
}: {
  slidesId?: string
  entry?: string
  /** Nome exibível do deck (a pasta registrada). */
  title: string
}) {
  const { t } = useTranslation()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  /** O que o runtime relatou ao carregar (é também o sinal de "carregou"). */
  const [deck, setDeck] = useState<DeckInfo | null>(null)
  const [index, setIndex] = useState(0)
  const [reloads, setReloads] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)
  const [showNotes, setShowNotes] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  /** Impressão em andamento (uma janela do Chromium) e a falha dela. */
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const src = useMemo(
    () => (slidesId && entry ? `${SLIDES_SCHEME}://${slidesId}/${entryPath(entry)}?r=${reloads}` : ""),
    [slidesId, entry, reloads],
  )

  /** Comando painel → deck. Sem janela montada, não há para quem mandar. */
  const post = useCallback((message: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.postMessage({ source: SLIDES_SOURCE, ...message }, "*")
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
    setDeck(null)
    setIndex(0)
    setFailed(null)
    setReloads((n) => n + 1)
  }, [])

  /**
   * Baixar em PDF. Quem imprime é o main, sobre o próprio index.html — a aba só
   * pede e mostra o resultado. O nome sugerido é o título do deck; o diálogo do
   * sistema deixa mudar.
   */
  const downloadPdf = useCallback(async () => {
    if (!slidesId || exporting) return
    setExporting(true)
    setExportError(null)
    try {
      const result = await slidesApi.exportPdf(slidesId, title)
      // Cancelar no diálogo de salvar não é erro: o usuário desistiu.
      if (!result.ok && !result.canceled) setExportError(result.error ?? t("slides.exportFailed"))
    } catch {
      setExportError(t("slides.exportFailed"))
    } finally {
      setExporting(false)
    }
  }, [slidesId, exporting, title, t])

  // Outro deck na mesma aba (o card de outro deck reusa a aba): começa do zero.
  useEffect(() => {
    setDeck(null)
    setIndex(0)
    setFailed(null)
  }, [slidesId])

  // ---------------------------------------------------------------- ponte
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = iframeRef.current?.contentWindow
      // A origem do iframe é opaca (sandbox sem allow-same-origin): quem diz
      // que a mensagem é DESTE iframe é a janela de origem, não a origem.
      if (!win || event.source !== win) return
      const data = event.data
      if (!data || data.source !== SLIDES_SOURCE) return
      if (data.type === "ready") {
        setFailed(null)
        setDeck({
          total: Number(data.total) || 0,
          width: Number(data.width) || 0,
          height: Number(data.height) || 0,
          slides: Array.isArray(data.slides) ? (data.slides as SlideInfo[]) : [],
        })
      } else if (data.type === "change") {
        setIndex(Number(data.index) || 0)
      } else if (data.type === "error") {
        setFailed(String(data.message ?? "unknown"))
      } else if (data.type === "request-fullscreen") {
        setFullscreen((value) => !value)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  // O agente reescreveu o arquivo (fs.watch do main): recarrega voltando ao
  // MESMO slide, que é o que deixa comparar o antes e o depois do ajuste.
  useEffect(() => {
    if (!slidesId) return
    const current = index
    return slidesApi.onChanged((payload) => {
      if (payload.id !== slidesId) return
      setDeck(null)
      setFailed(null)
      setReloads((n) => n + 1)
      // O runtime volta ao slide 0; reenvia o alvo assim que ele responder.
      window.setTimeout(() => {
        const win = iframeRef.current?.contentWindow
        win?.postMessage({ source: SLIDES_SOURCE, type: "go", index: current }, "*")
      }, 400)
    })
    // `index` de propósito fora das dependências: o alvo é o do momento da
    // recarga, não o de cada troca de slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Teclado do LADO DE FORA do iframe (com o foco na barra da aba). Dentro do
  // palco quem trata é o runtime — os dois não se atropelam, porque um keydown
  // não atravessa a fronteira do iframe.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase() ?? ""
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault()
        go(index + 1)
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault()
        go(index - 1)
      } else if (event.key === "Home") {
        event.preventDefault()
        go(0)
      } else if (event.key === "End") {
        event.preventDefault()
        go(total - 1)
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault()
        setFullscreen((value) => !value)
      } else if (event.key === "n" || event.key === "N") {
        event.preventDefault()
        setShowNotes((value) => !value)
      } else if (event.key === "Escape" && fullscreen) {
        setFullscreen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen, go, index, total])

  const current = deck?.slides[index]
  const progress = total > 0 ? ((index + 1) / total) * 100 : 0

  if (!slidesId || !entry) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-sidebar p-6 text-center">
        <Presentation className="size-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("slides.unavailable")}</p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "group/slides flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar",
        fullscreen && FULLSCREEN_OVERLAY_CLASS,
      )}
    >
      {/* Cabeçalho: deck + arquivo à esquerda; lista, notas, recarregar e tela
          cheia à direita. Mesmo respiro do cabeçalho do motion. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <Presentation className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
          <Badge variant="outline" className="max-w-44 shrink-0 truncate font-mono" title={entry}>
            {baseName(entry)}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <ToggleAction icon={List} label={t("slides.toggleList")} active={showList} onClick={() => setShowList((v) => !v)} />
          <ToggleAction
            icon={StickyNote}
            label={t("slides.toggleNotes")}
            active={showNotes}
            onClick={() => setShowNotes((v) => !v)}
          />
          <IconAction
            icon={exporting ? Loader2 : Download}
            label={exporting ? t("slides.exporting") : t("slides.exportPdf")}
            onClick={downloadPdf}
            disabled={exporting || !slidesId}
          />
          <IconAction icon={RotateCw} label={t("slides.reload")} onClick={reload} />
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "slides.exitFullscreen" : "slides.fullscreen")}
            onClick={() => setFullscreen((value) => !value)}
          />
        </div>
      </div>

      {/* A falha do PDF não pode substituir o palco: uma faixa fina avisa e o
          deck continua navegável. */}
      {exportError && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-destructive/10 px-3 py-1 text-[0.6875rem] text-destructive">
          <AlertTriangle className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{exportError}</span>
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="shrink-0 underline underline-offset-2"
          >
            {t("slides.dismiss")}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* O palco. O iframe ocupa a área toda e o runtime cuida da escala —
              a mesma imagem em qualquer tamanho de painel. */}
          <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
            <iframe
              ref={iframeRef}
              // Remonta o iframe (recarga de verdade): a URL do deck não muda
              // quando o arquivo é reescrito no lugar.
              key={`${slidesId}:${reloads}`}
              src={src}
              title={title}
              // SEM allow-same-origin de propósito: `allow-scripts` + same-origin
              // deixaria o deck remover o próprio sandbox.
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="h-full w-full border-0 bg-black"
            />
            {!deck && !failed && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/40 text-xs text-white/70">
                <Loader2 className="size-3.5 animate-spin" />
                {t("slides.loading")}
              </div>
            )}
            {failed && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center">
                <AlertTriangle className="size-4 text-destructive" />
                <span className="text-xs font-medium text-white">{t("slides.loadFailed")}</span>
                <span className="max-w-full break-words text-[11px] text-white/60">{failed}</span>
                <Button variant="outline" size="sm" onClick={reload}>
                  {t("slides.retry")}
                </Button>
              </div>
            )}
          </div>

          {/* Notas do apresentador — o que DIZER neste slide, fora da tela. */}
          {showNotes && (
            <div className="max-h-40 shrink-0 overflow-y-auto border-t border-border/60 bg-sidebar px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                <StickyNote className="size-3" />
                {t("slides.notes")}
              </div>
              {current?.notes ? (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">{current.notes}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("slides.noNotes")}</p>
              )}
            </div>
          )}

          {/* Transporte: anterior, contador, próximo — e a barra de progresso
              colada no rodapé, que é o que se olha de longe. */}
          <div className="relative flex shrink-0 items-center justify-center gap-1 border-t border-border/60 p-1.5">
            <IconAction
              icon={ChevronLeft}
              label={t("slides.previous")}
              onClick={() => go(index - 1)}
              disabled={index <= 0}
            />
            <span className="min-w-16 text-center text-[0.6875rem] tabular-nums text-muted-foreground">
              {total > 0 ? t("slides.counter", { index: index + 1, total }) : "—"}
            </span>
            <IconAction
              icon={ChevronRight}
              label={t("slides.next")}
              onClick={() => go(index + 1)}
              disabled={total === 0 || index >= total - 1}
            />
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>

        {/* Lista dos slides: o índice da apresentação, com o atual em destaque.
            Miniaturas de verdade exigiriam um render por slide (o iframe é
            opaco) — o título é o que se procura quando se navega. */}
        {showList && (
          <aside className="flex w-52 shrink-0 flex-col overflow-hidden border-l border-border/60">
            <div className="border-b border-border/60 px-3 py-2 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              {t("slides.slidesCount", { count: total })}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {deck?.slides.map((slide, i) => (
                <button
                  key={`${i}-${slide.title}`}
                  type="button"
                  onClick={() => go(i)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    i === index ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  <span className="w-4 shrink-0 text-right tabular-nums opacity-60">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{slide.title}</span>
                  {slide.notes && <StickyNote className="mt-0.5 size-3 shrink-0 opacity-50" />}
                </button>
              ))}
              {!deck && (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t("slides.loading")}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
