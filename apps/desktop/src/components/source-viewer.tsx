import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  List,
  Loader2,
  Minus,
  Plus,
  Printer,
  Search,
  X,
} from "lucide-react"
import { docsApi, type OutlineItem, type RenderedPage, type SourceText } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

/**
 * Visualizador de uma fonte no painel lateral, aberto pelo clique no anexo,
 * na aba Fontes ou numa citação da conversa.
 *
 * Dois modos:
 *
 * - Original: as páginas do PDF desenhadas por nós, com o trecho citado (ou a
 *   busca) grifado por cima. Não é o visualizador nativo do Chromium porque
 *   ele é um plugin fechado — dá para apontar a página pela URL, mas não para
 *   alcançar o conteúdo nem a busca dele, e portanto não há como marcar o
 *   trecho. Grifar dentro do PDF exige desenhar o PDF. O preço é não haver
 *   seleção de texto aqui: a página é uma imagem.
 * - Texto: o texto extraído com as linhas numeradas — onde se seleciona e
 *   copia, e o mesmo texto que o modelo leu (é o que garante que a linha 28
 *   daqui seja a linha 28 que ele citou).
 *
 * O que o visualizador nativo dava de graça está reimplementado aqui porque
 * ele foi trocado: localizar, sumário, zoom, imprimir e baixar. Imprimir é a
 * exceção e continua indo pelo caminho nativo — é o Chromium que sabe paginar
 * um PDF para papel, e refazer isso a partir das nossas imagens seria pior
 * justamente onde precisa ser fiel.
 */

/** Teto de linhas renderizadas de uma vez no modo Texto. */
const MAX_LINES = 20_000
/** Páginas por chamada de renderização — o mesmo teto do rasterizador. */
const BATCH = 5
const ZOOM_MIN = 0.75
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25
/** Escala de referência, exibida como 100% no controle de zoom. */
const ZOOM_BASE = 1.5

interface Match {
  page: number
  line: number
}

interface Focus {
  page: number
  /** Muda a cada pedido, para clicar duas vezes no mesmo item rolar de novo. */
  nonce: number
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
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [zoom, setZoom] = useState(ZOOM_BASE)
  const [focus, setFocus] = useState<Focus | null>(null)
  const [busy, setBusy] = useState<"print" | "export" | null>(null)
  // A busca foi preenchida pela citação (e não digitada): é o que mantém o
  // destaque preso à página citada em vez de marcar a frase onde ela repetir.
  const [fromCitation, setFromCitation] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    if (!sessionId || !docId) return
    setLoading(true)
    setOutline([])
    void docsApi.text(sessionId, docId).then((result) => {
      if (!alive) return
      setData(result)
      setLoading(false)
      // O documento abre como ele é sempre que houver original — inclusive
      // vindo de uma citação, porque agora o destaque também é desenhado lá.
      setMode(result?.hasOriginal ? "original" : "text")
    })
    return () => {
      alive = false
    }
  }, [sessionId, docId])

  /**
   * Citação: a busca já entra preenchida com o trecho citado. É o mesmo
   * mecanismo que marca a ocorrência no PDF e no texto, então o clique cai
   * direto no trecho e ainda dá para navegar pelas repetições.
   *
   * Separado da carga porque o documento não muda quando se clica em OUTRA
   * citação do mesmo arquivo — só o trecho muda, e reler o texto ali seria
   * trabalho jogado fora.
   */
  useEffect(() => {
    if (!data) return
    const cited = fromLine
      ? (data.pages.find((p) => p.num === page)?.lines.slice(fromLine - 1, toLine ?? fromLine) ?? [])
      : []
    const termo = cited.join(" ").trim()
    setFromCitation(termo.length >= 2)
    setQuery(termo.length >= 2 ? termo : "")
    setFindOpen(termo.length >= 2)
  }, [data, page, fromLine, toLine])

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

  // Vindo de citação, a ocorrência atual é a da página citada — a mesma frase
  // pode aparecer antes no documento, e começar pela primeira levaria o painel
  // para um lugar que não é o citado.
  useEffect(() => {
    if (!fromCitation || matches.length === 0) return
    const alvo = matches.findIndex((m) => m.page === (page ?? 0))
    if (alvo > 0) setMatchIndex(alvo)
  }, [fromCitation, matches, page])

  // Andar pelas ocorrências leva o modo Original junto: o contador diz 3/12 e
  // a página à vista tem que ser a da terceira.
  const current = matches[matchIndex]
  useEffect(() => {
    if (current) setFocus({ page: current.page, nonce: Date.now() })
  }, [current])

  // Documento gigante no modo Texto: renderizar tudo seriam dezenas de
  // milhares de nós. Corta em MAX_LINES, COMEÇANDO na página citada — abrir
  // uma citação da página 400 e mostrar as primeiras 300 seria pior que nada.
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

  useLayoutEffect(() => {
    if (!data || loading || mode !== "text") return
    anchorRef.current?.scrollIntoView({ block: "center" })
  }, [data, loading, mode, page, fromLine, matchIndex])

  // Sumário clicado no modo Texto: rola até o marcador daquela página.
  useLayoutEffect(() => {
    if (mode !== "text" || !focus) return
    textRef.current
      ?.querySelector(`[data-textpage="${focus.page}"]`)
      ?.scrollIntoView({ block: "start" })
  }, [mode, focus])

  if (!sessionId || !docId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {t("sources.viewerEmpty")}
      </div>
    )
  }

  const citedPage = page ?? 0
  const term = query.trim().toLowerCase()
  const truncated = (data?.pages.length ?? 0) > visiblePages.length
  // O que marcar no PDF: a busca quando há uma, senão o trecho citado. O
  // pdfjs localiza pelo TEXTO, não pelo número da linha.
  const citedLines =
    data?.pages
      .find((p) => p.num === citedPage)
      ?.lines.slice((fromLine ?? 1) - 1, toLine ?? fromLine ?? 0) ?? []
  const highlight = term.length >= 2 ? [query.trim()] : citedLines
  // Numa busca digitada o destaque vale em qualquer página; vindo da citação
  // ele fica preso à página citada.
  const highlightPage = fromCitation || term.length < 2 ? citedPage : null

  const run = async (action: "print" | "export") => {
    setBusy(action)
    if (action === "print") await docsApi.print(sessionId, docId)
    else await docsApi.export(sessionId, docId)
    setBusy(null)
  }

  const iconButton =
    "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={() => setOutlineOpen((open) => !open)}
          className={cn(iconButton, outlineOpen && "bg-accent text-foreground")}
          title={t("sources.outline")}
        >
          <List className="size-3.5" />
        </button>

        <div className="min-w-0 flex-1 px-1">
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

        {mode === "original" && (
          <>
            <button
              type="button"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
              className={iconButton}
              title={t("sources.zoomOut")}
            >
              <Minus className="size-3.5" />
            </button>
            <span className="w-9 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">
              {Math.round((zoom / ZOOM_BASE) * 100)}%
            </span>
            <button
              type="button"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
              className={iconButton}
              title={t("sources.zoomIn")}
            >
              <Plus className="size-3.5" />
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => setFindOpen((open) => !open)}
          className={cn(iconButton, findOpen && "bg-accent text-foreground")}
          title={t("sources.find")}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("export")}
          className={iconButton}
          title={t("sources.download")}
        >
          {busy === "export" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
        </button>
        {data?.hasOriginal && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("print")}
            className={iconButton}
            title={t("sources.print")}
          >
            {busy === "print" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Printer className="size-3.5" />
            )}
          </button>
        )}
        {data?.sourceUrl && (
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className={iconButton}
            title={data.sourceUrl}
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {findOpen && (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setFromCitation(false)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length > 0) {
                setMatchIndex((i) =>
                  e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length,
                )
              }
              if (e.key === "Escape") setFindOpen(false)
            }}
            placeholder={t("sources.findPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {matches.length > 0
              ? `${matchIndex + 1}/${matches.length}`
              : query.trim().length >= 2
                ? "0"
                : ""}
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

      <div className="flex min-h-0 flex-1">
        {outlineOpen && (
          <OutlinePanel
            outline={outline}
            total={data?.totalPages ?? 0}
            onGo={(n) => setFocus({ page: n, nonce: Date.now() })}
          />
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
            focus={focus ?? (citedPage ? { page: citedPage, nonce: 0 } : null)}
            highlight={highlight}
            highlightPage={highlightPage}
            zoom={zoom}
            onOutline={setOutline}
          />
        ) : (
          <div
            ref={textRef}
            className="flex-1 overflow-auto px-3 py-3 font-mono text-xs leading-relaxed"
          >
            {visiblePages.map((p) => (
              <div key={p.num} data-textpage={p.num}>
                <div className="sticky top-0 z-10 -mx-3 mb-1 bg-background/95 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {p.label ?? t("sources.pageOf", { page: p.num, total: data.totalPages })}
                </div>
                {p.lines.map((line, i) => {
                  const n = i + 1
                  const cited =
                    p.num === citedPage && n >= (fromLine ?? 0) && n <= (toLine ?? fromLine ?? 0)
                  const isCurrentMatch = current?.page === p.num && current?.line === n
                  const isAnchor = term.length >= 2 ? isCurrentMatch : cited && n === fromLine
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
                      <span className="w-8 shrink-0 select-none text-right text-muted-foreground/50">
                        {n}
                      </span>
                      <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                        <Marked text={line} term={term} />
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
            {truncated && (
              <p className="px-1 py-3 text-[11px] text-muted-foreground">
                {t("sources.truncatedView", { shown: visiblePages.length, total: data.totalPages })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Marca as ocorrências do termo dentro de uma linha do modo Texto. */
function Marked({ text, term }: { text: string; term: string }) {
  if (term.length < 2) return <>{text || " "}</>
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  let at = 0
  for (;;) {
    const found = lower.indexOf(term, at)
    if (found < 0) break
    if (found > at) parts.push(text.slice(at, found))
    parts.push(
      <mark key={found} className="rounded bg-amber-300/60 text-foreground dark:bg-amber-500/40">
        {text.slice(found, found + term.length)}
      </mark>,
    )
    at = found + term.length
  }
  if (parts.length === 0) return <>{text || " "}</>
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/**
 * Sumário do documento. Quando o PDF não traz um (a maioria dos digitalizados
 * e dos gerados por impressora não traz), cai na lista de páginas — o painel
 * continua servindo para pular, que é para o que se abre um sumário.
 */
function OutlinePanel({
  outline,
  total,
  onGo,
}: {
  outline: OutlineItem[]
  total: number
  onGo: (page: number) => void
}) {
  const { t } = useTranslation()
  const entries = outline.filter((item) => item.page !== null)
  return (
    <div className="w-52 shrink-0 overflow-auto border-r border-border/60 py-2">
      {entries.length > 0 ? (
        <ul>
          {entries.map((item, i) => (
            <li key={`${item.title}-${i}`}>
              <button
                type="button"
                onClick={() => onGo(item.page as number)}
                style={{ paddingLeft: `${0.75 + item.level * 0.75}rem` }}
                className="flex w-full cursor-pointer items-baseline gap-2 py-1 pr-2 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{item.title || "—"}</span>
                <span className="shrink-0 tabular-nums opacity-60">{item.page}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <p className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {t("sources.noOutline")}
          </p>
          <ul>
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
              <li key={n}>
                <button
                  type="button"
                  onClick={() => onGo(n)}
                  className="w-full cursor-pointer px-3 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t("sources.pageOf", { page: n, total })}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * O PDF desenhado por nós, página a página, com o trecho grifado.
 *
 * As páginas carregam sob demanda em lotes: cada chamada de renderização abre
 * uma janela oculta, então pedir de cinco em cinco é uma janela a cada cinco
 * páginas roladas, e não uma por página.
 */
function OriginalPages({
  sessionId,
  docId,
  total,
  focus,
  highlight,
  highlightPage,
  zoom,
  onOutline,
}: {
  sessionId: string
  docId: string
  total: number
  focus: Focus | null
  highlight: string[]
  /** Página em que o destaque é esperado; null quando ele é uma busca, que
   *  pode casar em qualquer uma. */
  highlightPage: number | null
  zoom: number
  onOutline: (outline: OutlineItem[]) => void
}) {
  const { t } = useTranslation()
  const [pages, setPages] = useState<Record<number, RenderedPage>>({})
  const requested = useRef(new Set<number>())
  const containerRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<HTMLDivElement>(null)
  // String em vez do array: um array novo a cada render reiniciaria o
  // carregamento a cada pintura.
  const highlightKey = highlight.join(" ")

  const load = useCallback(
    async (first: number) => {
      const batch = Math.max(1, first - ((first - 1) % BATCH))
      if (requested.current.has(batch)) return
      requested.current.add(batch)
      const wanted = highlightKey ? highlightKey.split(" ") : []
      const result = await docsApi.render(sessionId, docId, batch, BATCH, {
        scale: zoom,
        // Com trecho citado, procurar só no lote da página dele: marcar em
        // outra página uma frase que apenas se repete seria lido como a
        // citação. Numa busca o certo é o contrário — marcar em toda página.
        highlight:
          highlightPage === null || (highlightPage >= batch && highlightPage < batch + BATCH)
            ? wanted
            : [],
        includeOutline: requested.current.size === 1,
      })
      if (!result) return
      if (result.outline.length > 0) onOutline(result.outline)
      setPages((current) => {
        const next = { ...current }
        for (const p of result.pages) next[p.page] = p
        return next
      })
    },
    [sessionId, docId, zoom, highlightKey, highlightPage, onOutline],
  )

  // Zoom, documento ou destaque diferentes invalidam o que já foi desenhado.
  const startAt = focus?.page ?? 1
  useEffect(() => {
    requested.current.clear()
    setPages({})
    void load(startAt)
    // `startAt` fora das dependências de propósito: mudar de página não pode
    // jogar fora as imagens já renderizadas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

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

  useEffect(() => {
    if (focus) void load(focus.page)
  }, [focus, load])

  useLayoutEffect(() => {
    if (focus) focusRef.current?.scrollIntoView({ block: "start" })
  }, [focus, pages])

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-muted/40 p-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
          const rendered = pages[n]
          return (
            <div
              key={n}
              data-page={n}
              ref={n === focus?.page ? focusRef : undefined}
              className="relative overflow-hidden rounded bg-background shadow-sm"
              // Proporção de A4 enquanto não renderizou: sem uma altura
              // aproximada a lista colapsaria e tudo entraria na tela de uma
              // vez, disparando o carregamento do documento inteiro.
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
