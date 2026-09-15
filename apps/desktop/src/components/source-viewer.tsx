import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Search, X } from "lucide-react"
import { docsApi, type RenderedPage, type SourceText } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

/**
 * Visualizador de uma fonte no painel lateral, aberto pelo clique no anexo,
 * na aba Fontes ou numa citação da conversa.
 *
 * ROLAGEM CONTÍNUA, não página a página com setas: ler documento é rolar, e a
 * navegação por página existia aqui só porque a leitura do MODELO é paginada
 * (lá cada página custa contexto). São problemas diferentes e não precisavam
 * da mesma interface.
 *
 * Dois modos, onde o tipo permite:
 *
 * - Original: o arquivo servido pelo mesmo protocolo dos artefatos, no
 *   visualizador nativo — o mesmo componente e o mesmo comportamento de um PDF
 *   que o agente gerou, com zoom e busca do Chromium.
 * - Texto: o texto extraído com as linhas numeradas. É o único que sabe
 *   grifar um trecho citado, porque a citação aponta página e linha DESTE
 *   texto — é o mesmo que o modelo leu, e não uma segunda extração.
 *
 * O localizar daqui vale para o modo Texto e usa o mesmo destaque da citação:
 * quem chega por uma referência e quem chega procurando uma palavra veem a
 * mesma marcação.
 */

/** Teto de linhas renderizadas de uma vez. Acima disso a rolagem contínua
 *  passa a custar mais do que entrega: são dezenas de milhares de nós. */
const MAX_LINES = 20_000

/** Páginas por chamada de renderização — o mesmo teto do rasterizador. */
const BATCH = 5

interface Match {
  page: number
  line: number
}

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
  const [data, setData] = useState<SourceText | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<"original" | "text">("text")
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    if (!sessionId || !docId) return
    setLoading(true)
    void docsApi.text(sessionId, docId).then((result) => {
      if (!alive) return
      setData(result)
      setLoading(false)
      // Abrir pelo anexo mostra o arquivo como ele é; abrir por uma citação
      // mostra o texto, que é onde o trecho pode ser grifado.
      setMode(!fromLine && result?.hasOriginal ? "original" : "text")
    })
    return () => {
      alive = false
    }
  }, [sessionId, docId, fromLine])

  // Trocar de citação (outro clique na conversa) volta para o texto e para o
  // trecho novo, mesmo que o painel estivesse no modo original.
  useEffect(() => {
    if (fromLine) setMode("text")
  }, [fromLine, page])

  const matches = useMemo<Match[]>(() => {
    const term = query.trim().toLowerCase()
    if (!data || term.length < 2) return []
    const found: Match[] = []
    for (const p of data.pages) {
      for (let i = 0; i < p.lines.length; i += 1) {
        if (p.lines[i].toLowerCase().includes(term)) found.push({ page: p.num, line: i + 1 })
        if (found.length >= 500) return found
      }
    }
    return found
  }, [data, query])

  useEffect(() => setMatchIndex(0), [query])

  const scrollToAnchor = useCallback(() => {
    anchorRef.current?.scrollIntoView({ block: "center" })
  }, [])

  // Layout effect: rolar depois da pintura faria o trecho aparecer no topo e
  // pular, que é justamente o que atrapalha quem clicou para conferir.
  useLayoutEffect(() => {
    if (!data || loading || mode !== "text") return
    scrollToAnchor()
  }, [data, loading, mode, page, fromLine, matchIndex, scrollToAnchor])

  // Documento gigante: renderizar tudo seriam dezenas de milhares de nós e a
  // rolagem passa a custar mais do que entrega. Corta em MAX_LINES, mas
  // COMEÇANDO na página citada quando há uma — abrir uma citação da página 400
  // e mostrar as primeiras 300 seria pior que não abrir.
  const visiblePages = useMemo(() => {
    if (!data) return []
    const start = Math.max(0, data.pages.findIndex((p) => p.num === (page ?? 0)))
    const out: typeof data.pages = []
    let lines = 0
    for (let i = start; i < data.pages.length; i += 1) {
      lines += data.pages[i].lines.length
      if (lines > MAX_LINES && out.length > 0) break
      out.push(data.pages[i])
    }
    return out
  }, [data, page])

  if (!sessionId || !docId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {t("sources.viewerEmpty")}
      </div>
    )
  }

  const current = matches[matchIndex]
  const citedPage = page ?? 0
  // O texto das linhas citadas: é por ele que o destaque é localizado dentro
  // do PDF — o pdfjs dá as coordenadas do TEXTO, não do número da linha.
  const citedLines = data?.pages
    .find((p) => p.num === citedPage)
    ?.lines.slice((fromLine ?? 1) - 1, toLine ?? fromLine ?? 0) ?? []
  const term = query.trim().toLowerCase()
  const truncated = (data?.pages.length ?? 0) > visiblePages.length

  /** Marca as ocorrências do termo dentro da linha. */
  const renderLine = (text: string) => {
    if (term.length < 2) return text || " "
    const parts: React.ReactNode[] = []
    const lower = text.toLowerCase()
    let at = 0
    for (;;) {
      const found = lower.indexOf(term, at)
      if (found < 0) break
      if (found > at) parts.push(text.slice(at, found))
      parts.push(
        <mark key={`${found}`} className="rounded bg-amber-300/60 text-foreground dark:bg-amber-500/40">
          {text.slice(found, found + term.length)}
        </mark>,
      )
      at = found + term.length
    }
    if (parts.length === 0) return text || " "
    if (at < text.length) parts.push(text.slice(at))
    return parts
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{data?.filename ?? docId}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {docId}
            {data ? ` · ${t("sources.unitPages", { count: data.totalPages })}` : ""}
          </p>
        </div>

        {data?.hasOriginal && (
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

        {mode === "text" && (
          <button
            type="button"
            onClick={() => setFindOpen((open) => !open)}
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent",
              findOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            title={t("sources.find")}
          >
            <Search className="size-3.5" />
          </button>
        )}

        {data?.sourceUrl && (
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title={data.sourceUrl}
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {findOpen && mode === "text" && (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length > 0) {
                setMatchIndex((i) => (e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length))
              }
              if (e.key === "Escape") setFindOpen(false)
            }}
            placeholder={t("sources.findPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {matches.length > 0 ? `${matchIndex + 1}/${matches.length}` : query.trim().length >= 2 ? "0" : ""}
          </span>
          <button
            type="button"
            disabled={matches.length === 0}
            onClick={() => setMatchIndex((i) => (i - 1 + matches.length) % matches.length)}
            className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
          >
            <ChevronUp className="size-3" />
          </button>
          <button
            type="button"
            disabled={matches.length === 0}
            onClick={() => setMatchIndex((i) => (i + 1) % matches.length)}
            className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
          >
            <ChevronDown className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => setFindOpen(false)}
            className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

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
        <OriginalPages
          sessionId={sessionId}
          docId={docId}
          total={data.totalPages}
          citedPage={citedPage}
          highlight={citedLines}
        />
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-3 font-mono text-xs leading-relaxed">
          {visiblePages.map((p) => (
            <div key={p.num}>
              <div className="sticky top-0 z-10 -mx-3 mb-1 bg-background/95 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
                {p.label ?? t("sources.pageOf", { page: p.num, total: data.totalPages })}
              </div>
              {p.lines.map((line, i) => {
                const n = i + 1
                const cited = p.num === citedPage && n >= (fromLine ?? 0) && n <= (toLine ?? fromLine ?? 0)
                const isCurrentMatch = current?.page === p.num && current?.line === n
                // A âncora é o trecho citado quando se chega por referência, e
                // a ocorrência atual quando se chega procurando — os dois
                // caminhos rolam para o mesmo lugar do mesmo jeito.
                const isAnchor = query.trim().length >= 2 ? isCurrentMatch : cited && n === fromLine
                return (
                  <div
                    key={n}
                    ref={isAnchor ? anchorRef : undefined}
                    className={cn(
                      "flex gap-3 rounded px-1",
                      cited && "bg-primary/15 ring-1 ring-inset ring-primary/30",
                      isCurrentMatch && "ring-1 ring-inset ring-amber-500/70",
                    )}
                  >
                    <span className="w-8 shrink-0 select-none text-right text-muted-foreground/50">{n}</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                      {renderLine(line)}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
          {truncated && (
            <p className="px-1 py-3 text-[11px] text-muted-foreground">
              {t("sources.truncatedView", {
                shown: visiblePages.length,
                total: data.totalPages,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * O PDF desenhado por nós, página a página, com o trecho citado grifado.
 *
 * Por que não o visualizador nativo do Chromium, que a versão anterior usava:
 * ele é um plugin fechado — dá para apontar a página pela URL, mas não para
 * alcançar o conteúdo nem a busca dele, e portanto não há como marcar o trecho
 * citado. Grifar dentro do PDF exige desenhar o PDF.
 *
 * A troca é real e vale dizer: aqui não há seleção de texto, porque a página é
 * uma imagem. Selecionar e copiar continua no modo Texto, que também é onde a
 * busca marca as ocorrências.
 *
 * As páginas carregam sob demanda, em lotes: cada chamada de renderização abre
 * uma janela oculta, então pedir de cinco em cinco é uma janela a cada cinco
 * páginas roladas, e não uma por página.
 */
function OriginalPages({
  sessionId,
  docId,
  total,
  citedPage,
  highlight,
}: {
  sessionId: string
  docId: string
  total: number
  citedPage: number
  highlight: string[]
}) {
  const { t } = useTranslation()
  const [pages, setPages] = useState<Record<number, RenderedPage>>({})
  const requested = useRef(new Set<number>())
  const containerRef = useRef<HTMLDivElement>(null)
  const citedRef = useRef<HTMLDivElement>(null)

  const load = useCallback(
    async (first: number) => {
      const batch = Math.max(1, first - ((first - 1) % BATCH))
      if (requested.current.has(batch)) return
      requested.current.add(batch)
      const result = await docsApi.render(sessionId, docId, batch, BATCH, {
        // O destaque só é procurado no lote que contém a página citada:
        // procurar em todo lote marcaria, em outras páginas, uma frase que
        // simplesmente se repete — e o usuário leria isso como a citação.
        highlight: citedPage >= batch && citedPage < batch + BATCH ? highlight : [],
      })
      if (!result) return
      setPages((current) => {
        const next = { ...current }
        for (const p of result.pages) next[p.page] = p
        return next
      })
    },
    [sessionId, docId, citedPage, highlight],
  )

  // Primeiro lote: o que contém a página citada (ou o começo do documento).
  useEffect(() => {
    requested.current.clear()
    setPages({})
    void load(citedPage || 1)
  }, [load, citedPage])

  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const n = Number((entry.target as HTMLElement).dataset.page)
          if (n) void load(n)
        }
      },
      // Margem generosa: a página começa a renderizar antes de entrar na tela,
      // senão a rolagem encontra sempre um retângulo vazio.
      { root, rootMargin: "600px" },
    )
    for (const el of root.querySelectorAll("[data-page]")) observer.observe(el)
    return () => observer.disconnect()
  }, [load, total])

  useLayoutEffect(() => {
    if (citedPage && pages[citedPage]) citedRef.current?.scrollIntoView({ block: "start" })
  }, [citedPage, pages])

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-muted/40 p-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
          const rendered = pages[n]
          return (
            <div
              key={n}
              data-page={n}
              ref={n === citedPage ? citedRef : undefined}
              className="relative overflow-hidden rounded bg-background shadow-sm"
              // Proporção de A4 enquanto não renderizou: sem uma altura
              // aproximada, a lista inteira colapsaria e tudo entraria na tela
              // de uma vez, disparando o carregamento do documento todo.
              style={rendered ? undefined : { aspectRatio: "1 / 1.414" }}
            >
              {rendered ? (
                <>
                  <img
                    src={rendered.dataUrl}
                    alt={t("sources.pageOf", { page: n, total })}
                    className="block w-full"
                  />
                  {rendered.highlights.map((rect, i) => (
                    <span
                      key={i}
                      className="pointer-events-none absolute bg-amber-300/45 ring-1 ring-amber-500/50"
                      style={{
                        left: `${(rect.x / rendered.width) * 100}%`,
                        top: `${(rect.y / rendered.height) * 100}%`,
                        width: `${(rect.width / rendered.width) * 100}%`,
                        height: `${(rect.height / rendered.height) * 100}%`,
                      }}
                    />
                  ))}
                </>
              ) : (
                <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t("sources.pageOf", { page: n, total })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
