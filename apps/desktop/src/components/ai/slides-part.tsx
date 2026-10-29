import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  PanelRight,
  Presentation,
  RotateCw,
} from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { IconAction } from "@/src/components/ai/artifact-part"
import { useSlidesDeck } from "@/src/components/slides/use-slides-deck"
import { slidesApi } from "@/src/lib/ipc"
import { slidesRefOf } from "@/src/lib/slides-part-ref"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Altura do preview como fração da JANELA, não em pixels fixos — a mesma regra
 * do artefato. Um deck é 16:9, então a largura da coluna manda: a fração
 * mantém a presença relativa igual num notebook e num monitor grande.
 */
const PREVIEW_VIEWPORT_RATIO = 0.5
const MIN_PREVIEW_HEIGHT = 380

/**
 * O deck na conversa: o deck RENDERIZA aqui, como o artefato, em vez de virar
 * só um atalho para a aba do painel.
 *
 * A diferença de comportamento em relação ao card antigo é o que o deck é: uma
 * apresentação se lê clicando nela. Por isso o palco vem inline, com as duas
 * saídas de sempre — abrir na sidebar (para trabalhar com a aba ao lado) e tela
 * cheia (para apresentar). Fechar a aba não perde mais o deck de vista.
 *
 * O trabalho de verdade fica em dois lugares: o id/entrada do deck são
 * resolvidos no main (`slides:resolve`, sem abrir aba) e a ponte com o runtime
 * é o use-slides-deck, o mesmo da aba.
 */
export function SlidesPartView({ part, sessionId }: { part: ToolPart; sessionId?: string }) {
  const { t } = useTranslation()
  const ref = slidesRefOf(part)
  const id = ref?.id
  const path = ref?.path
  const name = ref?.name
  const [target, setTarget] = useState<{ id: string; entry: string } | null>(null)
  const [resolving, setResolving] = useState(true)
  const [attempt, setAttempt] = useState(0)

  // O deck do chat (slides_write) se resolve pelo título + sessão; o do projeto
  // (slides_preview) pelo caminho. Só o que existe é que vira URL de iframe.
  const resolveInput = useMemo(
    () => (id ? { id } : path ? { path } : name ? { sessionId, name } : null),
    [id, path, name, sessionId],
  )

  useEffect(() => {
    if (!resolveInput) {
      setResolving(false)
      return
    }
    let cancelled = false
    setResolving(true)
    slidesApi
      .resolve(resolveInput)
      .then((res) => {
        if (!cancelled) setTarget(res)
      })
      .catch(() => {
        if (!cancelled) setTarget(null)
      })
      .finally(() => {
        if (!cancelled) setResolving(false)
      })
    return () => {
      cancelled = true
    }
  }, [resolveInput, attempt])

  if (!ref || part.state === "error") return null

  if (resolving) {
    return (
      <div className="not-prose my-2 flex w-full items-center gap-2 rounded-lg border bg-background px-3 py-2.5">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <Truncate text={t("slides.loading")}>
          <span className="truncate text-xs text-muted-foreground">{t("slides.loading")}</span>
        </Truncate>
      </div>
    )
  }

  if (!target) {
    return (
      <div className="not-prose my-2 w-full rounded-lg border bg-background px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Presentation className="size-3.5 shrink-0 text-muted-foreground" />
          <Truncate text={ref.label}>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{ref.label}</span>
          </Truncate>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setAttempt((n) => n + 1)}>
            {t("slides.retry")}
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-destructive">{t("slides.gone")}</p>
      </div>
    )
  }

  return <SlidesDeckCard slidesId={target.id} entry={target.entry} label={ref.label} />
}

/**
 * O card com o palco. Componente separado porque o hook do deck só pode ser
 * chamado por quem SABE que o deck existe — a resolução acontece no pai.
 */
function SlidesDeckCard({ slidesId, entry, label }: { slidesId: string; entry: string; label: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const { iframeRef, src, deck, index, total, loading, failed, reload } = useSlidesDeck({ slidesId, entry })

  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 900 : window.innerHeight,
  )
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const previewHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.round(viewportHeight * PREVIEW_VIEWPORT_RATIO))

  const openInSidebar = useCallback(() => {
    void slidesApi.open({ id: slidesId })
  }, [slidesId])

  return (
    <>
      <div className="group/slides not-prose my-2 w-full overflow-hidden rounded-lg border bg-background shadow-sm">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <Presentation className="size-3.5 shrink-0 text-muted-foreground" />
            <Truncate text={label}>
              <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
            </Truncate>
            {deck && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("slides.slidesCount", { count: deck.total })}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover/slides:opacity-100 focus-within:opacity-100">
            <IconAction icon={RotateCw} label={t("slides.reload")} onClick={reload} />
            <IconAction icon={PanelRight} label={t("slides.openInSidebar")} onClick={openInSidebar} />
            <IconAction icon={Maximize2} label={t("slides.fullscreen")} onClick={() => setExpanded(true)} />
          </div>
        </div>

        <div className="relative bg-black" style={{ height: previewHeight }}>
          <iframe
            ref={iframeRef}
            key={src}
            src={src}
            title={label}
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
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/* flex-col, e não o grid padrão do DialogContent: com altura fixa as
            linhas implícitas esticam e a barra do título ficaria com metade do
            diálogo. Mesmo padrão do card de artefato. */}
        <DialogContent className="flex h-[88vh] max-w-[92vw] flex-col gap-0 p-0">
          <DialogTitle className="shrink-0 border-b border-border/60 px-4 py-2 pr-12 text-sm font-medium">
            {label}
          </DialogTitle>
          {/* Aberta por cima do card, a tela cheia começa no slide em que o
              usuário estava — e tem o seu próprio palco, com o seu iframe. */}
          <SlidesFullscreen slidesId={slidesId} entry={entry} label={label} initialIndex={index} totalFallback={total} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * O deck em tela cheia. Palco próprio (outro iframe, outra ponte): o card
 * continua vivo atrás, e cada um guarda o seu índice.
 */
function SlidesFullscreen({
  slidesId,
  entry,
  label,
  initialIndex,
  totalFallback,
}: {
  slidesId: string
  entry: string
  label: string
  initialIndex: number
  totalFallback: number
}) {
  const { t } = useTranslation()
  const { iframeRef, src, index, total, loading, failed, go, reload } = useSlidesDeck({
    slidesId,
    entry,
    initialIndex,
  })
  const shown = total || totalFallback
  const progress = shown > 0 ? ((index + 1) / shown) * 100 : 0

  return (
    <>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <iframe
          ref={iframeRef}
          key={src}
          src={src}
          title={label}
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

      <div className="relative flex shrink-0 items-center justify-center gap-1 border-t border-border/60 p-1.5">
        <IconAction icon={ChevronLeft} label={t("slides.previous")} onClick={() => go(index - 1)} disabled={index <= 0} />
        <span className="min-w-16 text-center text-[0.6875rem] tabular-nums text-muted-foreground">
          {shown > 0 ? t("slides.counter", { index: index + 1, total: shown }) : "—"}
        </span>
        <IconAction
          icon={ChevronRight}
          label={t("slides.next")}
          onClick={() => go(index + 1)}
          disabled={shown === 0 || index >= shown - 1}
        />
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
          <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </>
  )
}
