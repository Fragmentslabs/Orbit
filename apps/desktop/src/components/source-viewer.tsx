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
import { locateText, selectionScaleX } from "@/src/lib/pdf-text"
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
 *   trecho. Grifar dentro do PDF exige desenhar o PDF. A página é uma imagem,
 *   e a seleção vem de uma camada de texto transparente posicionada sobre os
 *   glifos (ver PageView).
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
  const [erro, setErro] = useState<string | null>(null)
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
  // O destaque sai SEMPRE do campo de busca — inclusive na citação, que entra
  // preenchendo ele. Assim apagar o filtro desmarca, que é o que se espera de
  // um filtro, em vez de deixar uma marca que não dá mais para tirar.
  const highlight = term.length >= 2 ? query.trim() : ""
  // Vindo da citação o destaque fica preso à página citada; digitando, vale em
  // qualquer uma.
  const highlightPage = fromCitation ? citedPage : null

  /**
   * Imprimir e baixar podem falhar (formato sem versão em PDF, arquivo que
   * sumiu, gravação negada). Antes o resultado era descartado e o botão
   * simplesmente não fazia nada — o erro precisa chegar em quem clicou.
   */
  const run = async (action: "print" | "export") => {
    setBusy(action)
    setErro(null)
    const result =
      action === "print"
        ? await docsApi.print(sessionId, docId)
        : await docsApi.export(sessionId, docId)
    // Cancelar no diálogo não é erro: o usuário desistiu.
    if (!result.ok && !("canceled" in result && result.canceled)) {
      setErro(result.error ?? t("sources.actionFailed"))
    }
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

      {erro && (
        <div className="flex items-start gap-2 border-b border-border/60 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <p className="min-w-0 flex-1">{erro}</p>
          <button
            type="button"
            onClick={() => setErro(null)}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-destructive/20"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

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

        {/*
          Sem spinner: trocar o documento inteiro por um giro a cada recarga
          pisca a página que a pessoa está lendo. Enquanto o texto não chegou,
          `data` ainda é o da leitura anterior (ou null na primeira), e o que
          aparece é a mensagem de ausente — que é o estado real.
        */}
        {!data ? (
          // Vazio enquanto a primeira leitura não voltou: dizer "não existe"
          // antes de ter procurado seria mentira, e um spinner faria o
          // documento piscar a cada recarga.
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
            {loading ? "" : t("sources.viewerMissing", { id: docId })}
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
                  // A faixa da citação some junto com o filtro, pelo mesmo
                  // motivo do destaque no PDF.
                  const cited =
                    fromCitation &&
                    p.num === citedPage &&
                    n >= (fromLine ?? 0) &&
                    n <= (toLine ?? fromLine ?? 0)
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
 * O PDF desenhado por nós, página a página.
 *
 * Três coisas acontecem sobre a mesma imagem, todas a partir dos ITENS DE
 * TEXTO que vêm com ela:
 *
 * - o destaque, calculado AQUI (locateText) e não no main. Antes cada letra
 *   digitada na busca pedia a página de volta, e o painel piscava
 *   "carregando" a cada tecla;
 * - a camada de seleção, spans transparentes sobre os glifos, que é o que
 *   permite selecionar e copiar num modo onde a página é imagem;
 * - o zoom, que muda a LARGURA exibida na hora e só depois troca a imagem por
 *   uma mais nítida — sem jogar fora a que já está na tela.
 *
 * Os itens vêm em fração da página, então servem a qualquer escala: mudar o
 * zoom não invalida destaque nem seleção.
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
  highlight: string
  /** Página em que o destaque é esperado; null quando ele é uma busca, que
   *  pode casar em qualquer uma. */
  highlightPage: number | null
  zoom: number
  onOutline: (outline: OutlineItem[]) => void
}) {
  const { t } = useTranslation()
  const [pages, setPages] = useState<Record<number, RenderedPage>>({})
  /** Escala já renderizada de cada lote — é o que decide se vale repedir. */
  const renderedAt = useRef(new Map<number, number>())
  const inFlight = useRef(new Set<number>())
  const containerRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<HTMLDivElement>(null)

  const load = useCallback(
    async (first: number) => {
      const batch = Math.max(1, first - ((first - 1) % BATCH))
      if (inFlight.current.has(batch)) return
      // Já renderizado NESTA escala: não repete. É o que evita o "carregando"
      // ao rolar de volta para uma página que já está pronta.
      if (renderedAt.current.get(batch) === zoom) return
      inFlight.current.add(batch)
      try {
        const result = await docsApi.render(sessionId, docId, batch, BATCH, {
          scale: zoom,
          includeText: true,
          includeOutline: renderedAt.current.size === 0,
        })
        if (!result) return
        if (result.outline.length > 0) onOutline(result.outline)
        renderedAt.current.set(batch, zoom)
        setPages((current) => {
          const next = { ...current }
          for (const p of result.pages) next[p.page] = p
          return next
        })
      } finally {
        inFlight.current.delete(batch)
      }
    },
    [sessionId, docId, zoom, onOutline],
  )

  // Trocar de documento zera tudo. Trocar o ZOOM não: as imagens antigas
  // seguem na tela, esticadas, enquanto as novas chegam — limpar faria o
  // documento sumir a cada clique no zoom.
  useEffect(() => {
    renderedAt.current.clear()
    inFlight.current.clear()
    setPages({})
  }, [sessionId, docId])

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
      <div
        className="mx-auto flex flex-col gap-3"
        // O zoom é a largura EXIBIDA. Redesenhar numa escala maior só aumenta a
        // resolução: sem isto a imagem chegava mais nítida do mesmo tamanho e o
        // botão parecia não fazer efeito nenhum.
        style={{ width: `${(zoom / ZOOM_BASE) * 100}%`, maxWidth: `${48 * (zoom / ZOOM_BASE)}rem` }}
      >
        {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
          <PageView
            key={n}
            page={n}
            rendered={pages[n]}
            highlight={highlightPage === null || highlightPage === n ? highlight : ""}
            outerRef={n === focus?.page ? focusRef : undefined}
            label={t("sources.pageOf", { page: n, total })}
          />
        ))}
      </div>
    </div>
  )
}

/** Uma página: a imagem, o destaque e a camada de seleção. */
function PageView({
  page,
  rendered,
  highlight,
  outerRef,
  label,
}: {
  page: number
  rendered?: RenderedPage
  highlight: string
  outerRef?: React.RefObject<HTMLDivElement>
  label: string
}) {
  const rects = useMemo(
    () => (rendered && highlight ? locateText(rendered.items, highlight) : []),
    [rendered, highlight],
  )
  const aspect = rendered && rendered.height > 0 ? rendered.width / rendered.height : 1
  const layerRef = useRef<HTMLDivElement>(null)

  /**
   * Ajusta a largura de cada span pela MEDIÇÃO, e não pela estimativa.
   *
   * O span tem que ocupar exatamente a largura que aquele texto ocupa na
   * imagem, senão a marca da seleção sobra ou falta em relação ao glifo. A
   * estimativa por meia altura chega perto mas erra em fonte condensada,
   * versalete e número; medir acerta.
   *
   * `offsetWidth` é a largura de LAYOUT e ignora o transform, então dá para
   * ler a largura natural mesmo com o scaleX anterior aplicado — sem ter que
   * zerá-lo antes e provocar um segundo cálculo de layout.
   */
  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer || !rendered) return
    const ajustar = () => {
      const pageWidth = layer.clientWidth
      if (!pageWidth) return
      const spans = layer.children
      const naturais: number[] = []
      for (let i = 0; i < spans.length; i += 1) naturais.push((spans[i] as HTMLElement).offsetWidth)
      for (let i = 0; i < spans.length; i += 1) {
        const item = rendered.items[i]
        if (!item) continue
        const alvo = item.width * pageWidth
        const escala = naturais[i] > 0 ? alvo / naturais[i] : selectionScaleX(item, aspect)
        ;(spans[i] as HTMLElement).style.transform = `scaleX(${Math.min(3, Math.max(0.2, escala))})`
      }
    }
    ajustar()
    // O zoom muda a largura da página: sem reobservar, a camada ficaria na
    // escala de antes.
    const observer = new ResizeObserver(ajustar)
    observer.observe(layer)
    return () => observer.disconnect()
  }, [rendered, aspect])

  return (
    <div
      data-page={page}
      ref={outerRef}
      className="relative overflow-hidden rounded bg-background shadow-sm"
      style={{
        // Proporção de A4 enquanto não renderizou: sem uma altura aproximada a
        // lista colapsaria e tudo entraria na tela de uma vez, disparando o
        // carregamento do documento inteiro.
        ...(rendered ? {} : { aspectRatio: "1 / 1.414" }),
        // Container de LARGURA (não de tamanho): a camada de seleção mede a
        // fonte em cqw, e assim ela acompanha o zoom sozinha. `size` conteria
        // também a altura, e a página — que se dimensiona pela imagem —
        // colapsaria.
        containerType: "inline-size",
      }}
    >
      {rendered ? (
        <>
          <img src={rendered.dataUrl} alt={label} className="block w-full select-none" />
          {rects.map((rect, i) => (
            <span
              key={i}
              className="pointer-events-none absolute bg-amber-300/45 ring-1 ring-amber-500/50"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
              }}
            />
          ))}
          {/* Camada de seleção: o texto visível está no pixel da imagem, e
              estes spans transparentes existem só para dar seleção e cópia.
              `selection:text-transparent` é o que impede o texto de APARECER
              ao ser selecionado: sem isso o Chromium pinta o selecionado com
              a cor de destaque do sistema, ignorando o transparente — e o
              texto surgia por cima do da imagem, desalinhado. */}
          <div ref={layerRef} className="pdf-text-layer absolute inset-0">
            {rendered.items.map((item, i) => (
              <span
                key={i}
                className="absolute origin-top-left whitespace-pre leading-none text-transparent"
                style={{
                  left: `${item.x * 100}%`,
                  top: `${item.y * 100}%`,
                  // A altura do item é fração da ALTURA da página, e o cqw
                  // mede a LARGURA: a proporção converte entre as duas.
                  fontSize: `${(item.height / aspect) * 100}cqw`,
                  // Estimativa inicial; o efeito abaixo a corrige por medição.
                  transform: `scaleX(${selectionScaleX(item, aspect)})`,
                }}
              >
                {item.text}
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {label}
        </div>
      )}
    </div>
  )
}

