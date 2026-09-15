import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react"
import { docsApi, type SourcePage } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

/**
 * Visualizador de uma fonte no painel lateral, aberto pelo clique numa
 * citação da conversa.
 *
 * Mostra o TEXTO EXTRAÍDO, com as linhas numeradas e o trecho citado grifado.
 * Não é a página renderizada do PDF de propósito: o destaque exato precisa de
 * coordenadas do trecho, que a rasterização não dá — e o que se quer conferir
 * numa citação é o que está escrito, não a diagramação. Para ver a aparência
 * da página existe o pdf_view_page.
 *
 * O texto é o MESMO que o modelo leu, e não uma segunda extração: é o que
 * garante que a linha 28 aqui seja a linha 28 que ele citou.
 */
export function SourceViewer({
  sessionId,
  docId,
  page,
  fromLine,
  toLine,
}: {
  sessionId?: string
  docId?: string
  page?: number
  fromLine?: number
  toLine?: number
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<SourcePage | null>(null)
  const [current, setCurrent] = useState(page ?? 1)
  const [loading, setLoading] = useState(true)
  // Abrir pelo anexo mostra o arquivo como ele é; abrir por uma citação mostra
  // o texto, que é onde o trecho pode ser grifado.
  const [mode, setMode] = useState<"original" | "text">(fromLine ? "text" : "original")
  const [image, setImage] = useState<{ dataUrl: string; page: number } | null>(null)
  const [rendering, setRendering] = useState(false)
  const highlightRef = useRef<HTMLDivElement>(null)

  // Trocar a citação (outro clique na conversa) volta para a página dela.
  useEffect(() => {
    setCurrent(page ?? 1)
    setMode(fromLine ? "text" : "original")
  }, [page, docId, fromLine])

  useEffect(() => {
    let alive = true
    if (!sessionId || !docId) return
    setLoading(true)
    void docsApi.page(sessionId, docId, current).then((result) => {
      if (!alive) return
      setData(result)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [sessionId, docId, current])

  // Renderiza a página só no modo original, e só quando ele está à vista:
  // rasterizar custa centenas de milissegundos por página.
  useEffect(() => {
    let alive = true
    if (mode !== "original" || !sessionId || !docId) return
    setRendering(true)
    void docsApi.render(sessionId, docId, current).then((result) => {
      if (!alive) return
      // null = tipo sem original exibível (.docx, planilha, texto colado):
      // cai no texto em vez de deixar um painel vazio.
      if (!result) setMode("text")
      else setImage({ dataUrl: result.dataUrl, page: result.page })
      setRendering(false)
    })
    return () => {
      alive = false
    }
  }, [mode, sessionId, docId, current])

  // Layout effect: rolar depois da pintura faria o trecho aparecer no topo e
  // pular, que é justamente o que atrapalha quem clicou para conferir.
  useLayoutEffect(() => {
    if (!data || loading || mode !== "text") return
    highlightRef.current?.scrollIntoView({ block: "center" })
  }, [data, loading, mode])

  if (!sessionId || !docId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
        {t("sources.viewerEmpty")}
      </div>
    )
  }

  const lines = (data?.text ?? "").split("\n")
  const from = fromLine ?? 0
  const to = toLine ?? fromLine ?? 0
  // O destaque só vale na página citada: navegando para outra, a mesma linha
  // 28 é outro texto e grifá-la seria uma afirmação falsa.
  const highlightOn = current === (page ?? 1)
  const width = String(lines.length).length

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {data?.filename ?? docId}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {docId}
            {data?.label ? ` · ${data.label}` : ""}
            {data ? ` · ${t("sources.pageOf", { page: data.page, total: data.totalPages })}` : ""}
          </p>
        </div>
        {data?.kind === "pdf" && (
          <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
            {(["original", "text"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={cn(
                  "cursor-pointer rounded px-2 py-0.5 text-[11px]",
                  mode === option
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(option === "original" ? "sources.modeOriginal" : "sources.modeText")}
              </button>
            ))}
          </div>
        )}
        {data?.sourceUrl && (
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title={data.sourceUrl}
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
        <button
          type="button"
          disabled={current <= 1}
          onClick={() => setCurrent((n) => Math.max(1, n - 1))}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          disabled={!data || current >= data.totalPages}
          onClick={() => setCurrent((n) => n + 1)}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("sources.loading")}
        </div>
      ) : !data ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          {t("sources.viewerMissing", { id: docId })}
        </div>
      ) : mode === "original" ? (
        <div className="flex-1 overflow-auto bg-muted/40 p-3">
          {image && image.page === current ? (
            <img
              src={image.dataUrl}
              alt={t("sources.pageOf", { page: current, total: data.totalPages })}
              className="mx-auto w-full max-w-2xl rounded shadow-sm"
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              {rendering && <Loader2 className="size-3.5 animate-spin" />}
              {t("sources.rendering")}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-3 py-3 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => {
            const n = i + 1
            const marked = highlightOn && n >= from && n <= to
            return (
              <div
                key={n}
                ref={marked && n === from ? highlightRef : undefined}
                className={cn(
                  "flex gap-3 rounded px-1",
                  marked && "bg-primary/15 ring-1 ring-inset ring-primary/30",
                )}
              >
                <span className="shrink-0 select-none text-right text-muted-foreground/50" style={{ width: `${width}ch` }}>
                  {n}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                  {line || " "}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
