import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle, ArrowLeft, Expand, Frame, LayoutGrid, Loader2, Maximize2, Minimize2, Play, RotateCcw } from "lucide-react"
import { DESIGN_SCHEME } from "@shared/media"
import { IconAction } from "@/src/components/ai/artifact-part"
import { Button } from "@/components/ui/button"
import { FloatingSidebar } from "@/src/components/fullscreen-dock"
import { designApi } from "@/src/lib/ipc"
import { FULLSCREEN_OVERLAY_CLASS } from "@/src/lib/fullscreen-overlay"
import { cn } from "@/lib/utils"
import { DESIGN_SOURCE, boardForHref, parseRuntimeMessage } from "./design-protocol"

/**
 * Modo apresentação do canvas, na aba própria: uma tela por vez, na proporção
 * dela e ajustada ao painel, e os links entre os artboards (`<a href="Outra.html">`)
 * navegam de verdade — o protótipo que o usuário clica, não o canvas de edição.
 *
 * Quem intercepta o clique é a ponte do artboard (modo `play`): ela não deixa o
 * iframe navegar sozinho — o painel é quem sabe QUAL tela vem a seguir (e qual
 * é a anterior, para o voltar), e a tela nova entra sempre pela mesma rota, com
 * a ponte injetada.
 */

interface Board {
  file: string
  title?: string
  w: number
  h: number
}

interface CanvasFile {
  boards: Record<string, { title?: string; x: number; y: number; w: number; h: number }>
  order: string[]
}

const encodeFile = (file: string) => file.split("/").map(encodeURIComponent).join("/")

export function DesignPresenter({
  designId,
  title,
  startFile,
  initialFullscreen = false,
}: {
  designId: string
  title: string
  startFile: string
  /** A aba nasceu do editor em tela cheia: já entra apresentando assim. */
  initialFullscreen?: boolean
}) {
  const { t } = useTranslation()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [canvas, setCanvas] = useState<CanvasFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(startFile)
  const [history, setHistory] = useState<string[]>([])
  const [reloads, setReloads] = useState(0)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [fullscreen, setFullscreen] = useState(initialFullscreen)
  // Como a tela se apresenta: "real" mostra o frame no tamanho dele (a tela
  // rola quando não cabe); "fit" escala para caber inteira na área da aba.
  const [mode, setMode] = useState<"fit" | "real">("fit")
  // Lista de telas: barra flutuante à esquerda, no molde da sidebar do modo
  // edição — fixável aberta, ou fechada abrindo no hover da borda. Fechada por
  // padrão para a tela não nascer coberta.
  const [screensOpen, setScreensOpen] = useState(false)

  const load = useCallback(() => {
    fetch(`${DESIGN_SCHEME}://${designId}/canvas.json?r=${Date.now()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<CanvasFile>
      })
      .then((data) => {
        setCanvas(data)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [designId])

  useEffect(() => load(), [load])

  // O agente mexeu no canvas: recarrega a tela em que a pessoa está.
  useEffect(
    () =>
      designApi.onChanged((payload) => {
        if (payload.id !== designId) return
        load()
        setReloads((n) => n + 1)
      }),
    [designId, load],
  )

  // O Play de outro artboard reaproveita a aba e só troca a tela inicial.
  useEffect(() => {
    setCurrent(startFile)
    setHistory([])
  }, [startFile])

  const boards = useMemo<Board[]>(() => {
    if (!canvas) return []
    return canvas.order.filter((file) => canvas.boards[file]).map((file) => ({ file, ...canvas.boards[file] }))
  }, [canvas])
  const files = useMemo(() => boards.map((b) => b.file), [boards])
  const board = boards.find((b) => b.file === current) ?? null

  const goTo = useCallback(
    (file: string, push = true) => {
      if (file === current) return
      if (push) setHistory((h) => [...h, current])
      setCurrent(file)
    },
    [current],
  )

  const back = useCallback(() => {
    setHistory((h) => {
      const previous = h[h.length - 1]
      if (previous === undefined) return h
      setCurrent(previous)
      return h.slice(0, -1)
    })
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = frameRef.current?.contentWindow
      if (!win || event.source !== win) return
      const msg = parseRuntimeMessage(event.data)
      if (!msg) return
      if (msg.type === "ready") {
        win.postMessage({ source: DESIGN_SOURCE, type: "mode", select: false, play: true }, "*")
      } else if (msg.type === "navigate") {
        const target = boardForHref(msg.href, files)
        if (target) goTo(target)
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [files, goTo])

  // Esc sai da tela cheia (a aba só ouve enquanto está nela — fora, o Esc é de
  // quem estiver com o foco).
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen])

  // O Esc com o foco DENTRO do artboard chega pela ponte (ele cancela as teclas).
  useEffect(() => {
    if (!fullscreen) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const msg = parseRuntimeMessage(event.data)
      if (msg?.type === "key" && msg.phase === "down" && msg.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [fullscreen])

  // A tela ocupa o palco inteiro, na proporção dela.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // "fit": escala pela LARGURA (a tela encosta nas laterais, sem faixa) e a
  // altura acompanha a proporção; se ficar mais alta que a área, o palco rola
  // na vertical em vez de cortar atrás do header. "real": tamanho original.
  const scale = board && box.w > 0 && box.h > 0 ? box.w / board.w : 1
  const fit = mode === "fit"
  const overflowsY = fit && !!board && box.h > 0 && board.h * scale > box.h + 1

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar", fullscreen && FULLSCREEN_OVERLAY_CLASS)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 p-2">
        <div className="flex min-w-0 items-center gap-2">
          <Play className="size-3.5 shrink-0 text-muted-foreground" fill="currentColor" />
          <span className="truncate text-xs font-medium text-muted-foreground">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {history.length > 0 && <IconAction icon={ArrowLeft} label={t("design.present.back")} onClick={back} />}
          <IconAction
            icon={RotateCcw}
            label={t("design.present.restart")}
            onClick={() => {
              setHistory([])
              setCurrent(startFile)
              setReloads((n) => n + 1)
            }}
          />
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            variant={fit ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={fit}
            title={t("design.present.fit")}
            aria-label={t("design.present.fit")}
            onClick={() => setMode("fit")}
          >
            <Expand className="size-3.5" />
          </Button>
          <Button
            variant={!fit ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={!fit}
            title={t("design.present.real")}
            aria-label={t("design.present.real")}
            onClick={() => setMode("real")}
          >
            <Frame className="size-3.5" />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <IconAction
            icon={fullscreen ? Minimize2 : Maximize2}
            label={t(fullscreen ? "design.exitFullscreen" : "design.fullscreen")}
            onClick={() => setFullscreen((v) => !v)}
          />
        </div>
      </div>

      <div
        ref={stageRef}
        className={cn(
          "relative flex min-h-0 flex-1 overflow-hidden bg-black/30",
          // "fit" preenche a largura; centraliza na vertical quando cabe e rola
          // (alinhado ao topo) quando a tela é mais alta que a área. "real"
          // deixa o frame no tamanho dele e rola quando ele é maior. Sem tela
          // (carregando/erro), centraliza o aviso em qualquer modo.
          !board
            ? "items-center justify-center"
            : fit
              ? cn(
                  "justify-center overflow-x-hidden",
                  overflowsY ? "items-start overflow-y-auto" : "items-center overflow-hidden",
                )
              : "overflow-auto",
        )}
      >
        {error && (
          <div className="flex items-center gap-2 text-[11px] text-destructive">
            <AlertTriangle className="size-3.5" />
            {error}
          </div>
        )}
        {!canvas && !error && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {canvas && !board && <p className="text-xs text-muted-foreground">{t("design.present.missing", { file: current })}</p>}
        {board && (
          <div
            className={cn(
              "relative overflow-hidden bg-white shadow-lg ring-1 ring-border/60",
              // `m-auto` centra com folga e, sem folga, libera a rolagem (o
              // `justify-center` do flex clipa o topo/esquerda nesse caso).
              !fit && "m-auto",
            )}
            style={fit ? { width: board.w * scale, height: board.h * scale } : { width: board.w, height: board.h }}
          >
            <iframe
              ref={frameRef}
              key={`${designId}:${current}:${reloads}`}
              src={`${DESIGN_SCHEME}://${designId}/${encodeFile(current)}?play=${reloads}`}
              title={board.title ?? current}
              sandbox="allow-scripts"
              allow=""
              referrerPolicy="no-referrer"
              className="absolute top-0 left-0 border-0"
              style={{
                width: board.w,
                height: board.h,
                transform: fit ? `scale(${scale})` : undefined,
                transformOrigin: "top left",
              }}
            />
          </div>
        )}

        {/* Em tela cheia, a lista de telas fica na barra flutuante da esquerda —
            o mesmo gesto da sidebar do modo edição (fixa aberta pelo botão, ou
            abre no hover da borda quando fechada). No painel (sem tela cheia)
            ela vira a faixa horizontal de baixo. */}
        {fullscreen && boards.length > 1 && (
          <FloatingSidebar
            side="left"
            open={screensOpen}
            onToggle={() => setScreensOpen((v) => !v)}
            openLabel={t("design.present.showScreens")}
            closeLabel={t("design.present.hideScreens")}
          >
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 text-[11px] font-medium">
              <LayoutGrid className="size-3" />
              {t("design.present.screens")}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
              {boards.map((b) => (
                <button
                  key={b.file}
                  type="button"
                  onClick={() => goTo(b.file)}
                  className={cn(
                    "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                    b.file === current
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span className="truncate">{b.title ?? b.file}</span>
                </button>
              ))}
            </div>
          </FloatingSidebar>
        )}
      </div>

      {/* No painel (sem tela cheia) a lista de telas fica na faixa de baixo,
          com o preview ocupando o resto por cima. */}
      {!fullscreen && boards.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/60 p-2">
          {boards.map((b) => (
            <button
              key={b.file}
              type="button"
              onClick={() => goTo(b.file)}
              title={b.title ?? b.file}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-[11px] transition-colors",
                b.file === current
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span className="block max-w-[10rem] truncate">{b.title ?? b.file}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
