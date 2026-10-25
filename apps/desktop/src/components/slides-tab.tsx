import { useCallback, useEffect, useRef, useState } from "react"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconAction } from "@/src/components/ai/artifact-part"
import { useSlidesDeck } from "@/src/components/slides/use-slides-deck"
import { slidesApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"

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
 * O palco de um deck de slides na aba do painel direito.
 *
 * O iframe carrega a PASTA registrada por `orbit-slides://<id>/<entrada>`; a
 * ponte com o runtime injetado fica em use-slides-deck.ts, compartilhada com o
 * card do chat. Aqui ficam a moldura da aba e as rédeas que são de interface:
 * a lista, as notas do apresentador, o contador e a tela cheia.
 *
 * A lista mora no RODAPÉ, em fita horizontal, e não numa coluna à direita: o
 * painel é estreito, e uma sidebar de 208px comia justamente a largura de que o
 * 16:9 precisa. Deitada, a mesma informação custa ~44px de altura e o palco
 * respira.
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
  const [showList, setShowList] = useState(true)
  const [showNotes, setShowNotes] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  /** Impressão em andamento (uma janela do Chromium) e a falha dela. */
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const { iframeRef, src, deck, index, total, current, loading, failed, go, reload } = useSlidesDeck({
    slidesId,
    entry,
    onFullscreenRequest: () => setFullscreen((value) => !value),
  })

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

  // A lista rola sozinha até o slide atual: num deck de 20, a linha ativa não
  // pode ficar fora de vista só porque o usuário avançou pelo teclado.
  const activeRowRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" })
  }, [index])

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

      {/* O palco. O iframe ocupa a área toda e o runtime cuida da escala — a
          mesma imagem em qualquer tamanho de painel. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <iframe
          ref={iframeRef}
          // A URL muda a cada recarga (o arquivo é reescrito no lugar), então
          // ela é a chave do remount.
          key={src}
          src={src}
          title={title}
          // SEM allow-same-origin de propósito: `allow-scripts` + same-origin
          // deixaria o deck remover o próprio sandbox.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-black"
        />
        {loading && (
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
        <div className="max-h-32 shrink-0 overflow-y-auto border-t border-border/60 bg-sidebar px-3 py-2">
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

      {/* A lista, em pé, no rodapé: o índice da apresentação empilhado acima do
          transporte, com rolagem na vertical. Uma fita deitada (ou uma coluna à
          direita) competia com o 16:9 do palco; aqui ela só custa altura, e só
          enquanto está aberta. Miniaturas de verdade exigiriam um render por
          slide (o iframe é opaco) — o título é o que se procura ao navegar. */}
      {showList && !!deck?.slides.length && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border/60">
          {deck.slides.map((slide, i) => (
            <button
              key={`${i}-${slide.title}`}
              ref={i === index ? activeRowRef : undefined}
              type="button"
              onClick={() => go(i)}
              title={slide.title}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors",
                i === index
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/40",
              )}
            >
              <span className="w-4 shrink-0 text-right text-[10px] tabular-nums opacity-60">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{slide.title}</span>
              {slide.notes && <StickyNote className="size-2.5 shrink-0 opacity-50" />}
            </button>
          ))}
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
  )
}
