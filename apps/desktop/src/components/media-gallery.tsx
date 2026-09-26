import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, CodeXml, FileText, Folder, FolderGit2, HardDriveIcon, ImageOff, Layers, MessageSquare, RefreshCw, Search, Trash2, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { mediaKind, thumbUrl, type MediaEntry, type MediaSource } from "@shared/media"
import { folderKey, normalizeFolderName } from "@shared/chat"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { artifactApi, mediaApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useTheme } from "@/components/theme-provider"
import { openDocumentInPanel } from "@/src/lib/open-document"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"

/**
 * Galeria de mídia: página dedicada (aba do painel direito) com o que o agente
 * produziu — imagens (show_image, screenshots, capturas de scripts/lotes),
 * artefatos HTML (create_artifact) e as prints coladas pelo usuário. Lê o
 * registry do main (orbit-data/media/index.json), que indexa os dois tipos:
 * o arquivo do artefato mora em orbit-data/artifacts, e o registro aponta
 * para ele — nada é duplicado.
 *
 * Escopada por modo: no modo chat mostra só mídia de sessões de chat; no
 * modo código, só de sessões de código.
 *
 * Não é um card no chat: aqui o usuário revisita, abre no chat de origem,
 * exclui em lote e enxerga o espaço em disco.
 */

type SourceFilter = "all" | MediaSource
type PeriodFilter = "all" | "today" | "week" | "month"

/**
 * ESCOPO da galeria — um filtro só, com quatro naturezas.
 *
 * São quatro porque são quatro as formas de a mídia pertencer a algo: a
 * conversa em que nasceu, a pasta da sidebar daquela conversa, o repositório
 * em que ela trabalhava, ou nada disso. Separar em vários filtros faria o
 * usuário combinar escopos que não se cruzam.
 *
 * A pasta vem da SESSÃO, não do registro: só documento grava `folderId`, e o
 * filtro precisa valer para imagem e artefato também.
 */
const SCOPE_ALL = "all"
const SCOPE_SESSION = "session"
/** Mídia que não pertence a pasta nem a repositório — a de chat solto. */
const SCOPE_LOOSE = "__loose__"
const FOLDER_PREFIX = "folder:"
const PROJECT_PREFIX = "project:"

const PERIOD_MS: Record<Exclude<PeriodFilter, "all">, number> = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
}

/** Backfill roda uma vez por processo do renderer — é idempotente no main. */
let backfillDone = false

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Rola até a mensagem no chat e pisca o destaque (mesmo padrão da busca). */
function scrollToMessage(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  const prevBg = el.style.backgroundColor
  const prevTransition = el.style.transition
  el.style.transition = "background-color 0.4s ease"
  el.style.backgroundColor = "var(--accent)"
  setTimeout(() => {
    el.style.backgroundColor = prevBg
    setTimeout(() => { el.style.transition = prevTransition }, 400)
  }, 700)
}

function Thumb({ entry, selected, selecting, onToggle, onOpen, versions = 1 }: {
  entry: MediaEntry
  selected: boolean
  selecting: boolean
  onToggle: () => void
  onOpen: () => void
  /** Quantas imagens existem na cadeia que este tile representa. */
  versions?: number
}) {
  const [failed, setFailed] = useState(false)
  const { theme } = useTheme()
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  // Artefato sem miniatura (captura falhou) ou imagem quebrada caem no ícone —
  // o tile continua clicável, o ativo ainda existe.
  // O documento vivo tem uma capa por tema: a do grid é a do tema atual, para
  // o tile não ser a única coisa branca numa tela escura.
  const preview = thumbUrl(entry, isDark)
  const kind = mediaKind(entry)
  const isArtifact = kind === "artifact"
  const isDocument = kind === "document"
  const FallbackIcon = isDocument ? FileText : isArtifact ? CodeXml : ImageOff
  // Selo por tipo: o grid mistura imagem, página e documento, e o clique faz
  // coisas diferentes em cada um — sem o selo a diferença é invisível.
  const badge = isDocument
    ? (entry.formats ?? []).map((f) => f.toUpperCase()).join("/") || "DOC"
    : isArtifact
      ? "HTML"
      : null

  return (
    <div
      className={cn(
        "group relative aspect-video overflow-hidden rounded-lg border bg-muted/30 transition-colors",
        selected ? "border-primary ring-1 ring-primary" : "border-sidebar-border hover:border-ring",
      )}
    >
      <button
        type="button"
        onClick={() => (selecting ? onToggle() : onOpen())}
        className="block size-full cursor-pointer"
        title={entry.name || entry.id}
      >
        {failed || !preview ? (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <FallbackIcon className="size-4" />
          </div>
        ) : (
          <img
            src={preview}
            alt={entry.name ?? entry.id}
            loading="lazy"
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        )}
      </button>
      {badge && (
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
          {isDocument ? <FileText className="size-3" /> : <CodeXml className="size-3" />}
          {badge}
        </span>
      )}
      {/* Pilha de edições: o tile é a versão atual, e o selo diz que existe
          histórico atrás dela — sem ele, o colapso pareceria perda. */}
      {!badge && versions > 1 && (
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
          <Layers className="size-3" />
          {versions}
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "absolute left-1.5 top-1.5 flex size-4 items-center justify-center rounded-sm border bg-background/80 transition-opacity",
          selected ? "border-primary bg-primary text-primary-foreground opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        {selected && <CheckIcon className="size-3" />}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3">
        <p className="truncate text-[10px] font-medium text-white">{entry.name || entry.id}</p>
      </div>
    </div>
  )
}

/** Chip do filtro de escopo. */
function ScopeChip({
  active,
  onClick,
  label,
  Icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  Icon?: LucideIcon
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "flex max-w-40 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50",
      )}
    >
      {Icon && <Icon className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  )
}

export function MediaGallery() {
  const { t, i18n } = useTranslation()
  const { mode, setMode, folders } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  /** Pastas da sidebar (agrupamento de conversas) — diferentes das pastas de
   *  trabalho do workspace, que são repositórios. */
  const sidebarFolders = useSessionStore((s) => s.folders)
  const activeSessionId = useSessionStore((s) => s.activeIds[mode])
  const [entries, setEntries] = useState<MediaEntry[]>([])
  const [usage, setUsage] = useState({ count: 0, bytes: 0 })
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<SourceFilter>("all")
  const [period, setPeriod] = useState<PeriodFilter>("all")
  /** Escolha explícita do usuário; null = segue o padrão do contexto atual. */
  const [scopeOverride, setScopeOverride] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<MediaEntry | null>(null)
  /** Versões da imagem aberta, da mais antiga para a atual. */
  const [previewChain, setPreviewChain] = useState<MediaEntry[] | null>(null)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const [list, disk] = await Promise.all([mediaApi.list(), mediaApi.usage()])
    if (!mounted.current) return
    setEntries(list)
    setUsage(disk)
    setLoading(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void (async () => {
      // Primeira abertura: indexa as imagens que existiam antes do registry.
      if (!backfillDone) {
        backfillDone = true
        try {
          await mediaApi.backfill()
        } catch {
          // registro é melhor-esforço — a lista ainda funciona
        }
      }
      await refresh()
    })()
    return () => { mounted.current = false }
  }, [refresh])

  // Artefato reescrito com a galeria aberta: o registro muda (revisão, tamanho,
  // título) e a miniatura é recapturada com o MESMO nome de arquivo. Só o
  // refresh traz a revisão nova, que é o que desempata a URL da miniatura.
  useEffect(() => artifactApi.onUpdated(() => void refresh()), [refresh])

  /** Sessões do modo atual — escopo da galeria (chat mostra só chat, etc). */
  const modeSessionIds = useMemo(
    () => new Set(sessions.filter((s) => s.mode === mode).map((s) => s.id)),
    [sessions, mode],
  )

  /**
   * Projeto de uma entrada: o diretório da sessão que a originou, normalizado
   * com a MESMA regra das pastas da sidebar (folderKey/normalizeFolderName).
   * Entrada sem sessão conhecida (órfã do backfill) ou sessão sem diretório
   * (modo chat) não tem projeto.
   */
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const projectOf = useCallback((entry: MediaEntry): { key: string; label: string } | null => {
    if (!entry.sessionId) return null
    const directory = sessionById.get(entry.sessionId)?.directory
    if (!directory) return null
    const label = normalizeFolderName(directory)
    return { key: folderKey(label), label }
  }, [sessionById])

  /**
   * Pasta da sidebar de uma entrada, pela sessão que a originou. Entrada órfã
   * (backfill) ou conversa fora de pasta não tem.
   */
  const folderById = useMemo(
    () => new Map(sidebarFolders.map((f) => [f.id, f.name])),
    [sidebarFolders],
  )
  const folderOf = useCallback(
    (entry: MediaEntry): { id: string; name: string } | null => {
      if (!entry.sessionId) return null
      const folderId = sessionById.get(entry.sessionId)?.folderId
      if (!folderId) return null
      const name = folderById.get(folderId)
      return name ? { id: folderId, name } : null
    },
    [sessionById, folderById],
  )

  /** Entradas no escopo do modo atual (aplica o filtro de sessão uma vez só). */
  const scopedEntries = useMemo(
    () => entries.filter((entry) => !entry.sessionId || modeSessionIds.has(entry.sessionId)),
    [entries, modeSessionIds],
  )

  /** Pastas da sidebar com mídia no escopo — os chips do filtro. */
  const folderOptions = useMemo(() => {
    const byId = new Map<string, string>()
    for (const entry of scopedEntries) {
      const f = folderOf(entry)
      if (f && !byId.has(f.id)) byId.set(f.id, f.name)
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [scopedEntries, folderOf])

  /** Projetos com mídia no escopo — os chips do filtro. */
  const projectOptions = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const entry of scopedEntries) {
      const p = projectOf(entry)
      if (p && !byKey.has(p.key)) byKey.set(p.key, p.label)
    }
    return [...byKey.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [scopedEntries, projectOf])

  const hasLoose = useMemo(
    () => scopedEntries.some((entry) => !folderOf(entry) && !projectOf(entry)),
    [scopedEntries, folderOf, projectOf],
  )

  /** Uma entrada cai neste escopo? É a regra única — filtro, padrão e chips
   *  perguntam todos aqui, então não há como divergirem. */
  const matchesScope = useCallback(
    (entry: MediaEntry, value: string): boolean => {
      if (value === SCOPE_ALL) return true
      if (value === SCOPE_SESSION) return !!activeSessionId && entry.sessionId === activeSessionId
      if (value === SCOPE_LOOSE) return !folderOf(entry) && !projectOf(entry)
      if (value.startsWith(FOLDER_PREFIX)) {
        return folderOf(entry)?.id === value.slice(FOLDER_PREFIX.length)
      }
      if (value.startsWith(PROJECT_PREFIX)) {
        return projectOf(entry)?.key === value.slice(PROJECT_PREFIX.length)
      }
      return true
    },
    [activeSessionId, folderOf, projectOf],
  )

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  )

  /**
   * O escopo que a galeria abre quando o usuário ainda não escolheu.
   *
   * Do mais específico que o contexto oferece para o mais amplo: a pasta da
   * sidebar da conversa, senão o repositório em que ela trabalha, senão — num
   * CHAT SOLTO, que não pertence a nenhum dos dois — a própria conversa.
   *
   * Cada candidato só vale se tiver mídia: abrir a galeria vazia esconderia
   * tudo que existe, e o usuário não teria como saber que o filtro é que está
   * apertado.
   */
  const defaultScope = useMemo(() => {
    const has = (value: string) => scopedEntries.some((entry) => matchesScope(entry, value))
    if (activeSession?.folderId) {
      const value = `${FOLDER_PREFIX}${activeSession.folderId}`
      if (has(value)) return value
    }
    const directory = activeSession?.directory ?? folders[0]
    if (directory) {
      const value = `${PROJECT_PREFIX}${folderKey(normalizeFolderName(directory))}`
      if (has(value)) return value
    }
    if (activeSessionId && has(SCOPE_SESSION)) return SCOPE_SESSION
    return SCOPE_ALL
  }, [activeSession, activeSessionId, folders, scopedEntries, matchesScope])

  /** Valores que existem agora — o override morre quando sai de cena (ex.: o
   *  usuário troca de modo e aquela pasta não tem mídia aqui). */
  const scopeValues = useMemo(
    () =>
      new Set([
        SCOPE_ALL,
        SCOPE_SESSION,
        SCOPE_LOOSE,
        ...folderOptions.map((f) => `${FOLDER_PREFIX}${f.id}`),
        ...projectOptions.map((p) => `${PROJECT_PREFIX}${p.key}`),
      ]),
    [folderOptions, projectOptions],
  )

  /** Tudo derivado: nada de setState em effect. */
  const scope = useMemo(
    () => (scopeOverride && scopeValues.has(scopeOverride) ? scopeOverride : defaultScope),
    [scopeOverride, scopeValues, defaultScope],
  )

  /**
   * O que aparece na grade, com a cadeia de edições colapsada.
   *
   * Cinco passos de um mesmo meme eram cinco tiles — a galeria virava o
   * rascunho do agente em vez do acervo do usuário. Aqui, quem foi editado
   * depois sai da grade e passa a ser versão de quem o sucedeu; só as pontas
   * ficam. Ramificação funciona pelo mesmo caminho: três variantes da mesma
   * base são três pontas, e a base some atrás delas.
   */
  const { visible, versionsByHead } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const since = period === "all" ? 0 : Date.now() - PERIOD_MS[period]
    const filtrados = scopedEntries.filter((entry) => {
      if (source !== "all" && entry.source !== source) return false
      if (!matchesScope(entry, scope)) return false
      if (entry.createdAt < since) return false
      if (!needle) return true
      return `${entry.name ?? ""} ${entry.taskId ?? ""} ${entry.id}`.toLowerCase().includes(needle)
    })

    const porId = new Map(scopedEntries.map((e) => [e.id, e]))
    const superadas = new Set<string>()
    for (const entry of filtrados) if (entry.parentId) superadas.add(entry.parentId)

    const pontas = filtrados.filter((entry) => !superadas.has(entry.id))
    const cadeias = new Map<string, MediaEntry[]>()
    for (const ponta of pontas) {
      const cadeia: MediaEntry[] = []
      const vistos = new Set<string>()
      let atual: MediaEntry | undefined = ponta
      // O ancestral entra mesmo filtrado de fora: a versão anterior continua
      // sendo história desta imagem, e o filtro é sobre o que a grade mostra.
      while (atual && !vistos.has(atual.id)) {
        vistos.add(atual.id)
        cadeia.unshift(atual)
        atual = atual.parentId ? porId.get(atual.parentId) : undefined
      }
      if (cadeia.length > 1) cadeias.set(ponta.id, cadeia)
    }
    return { visible: pontas, versionsByHead: cadeias }
  }, [scopedEntries, source, period, query, scope, matchesScope])

  /**
   * Ids a apagar de fato: apagar a ponta leva junto os degraus que levaram até
   * ela, senão eles sobrariam órfãos e invisíveis, ocupando disco. A raiz
   * anexada pelo usuário é onde a poda para — a foto dele não é rascunho.
   */
  const comAncestrais = useCallback(
    (ids: string[]): string[] => {
      const porId = new Map(scopedEntries.map((e) => [e.id, e]))
      const alvo = new Set(ids)
      for (const id of ids) {
        let atual = porId.get(id)
        while (atual?.parentId) {
          const pai = porId.get(atual.parentId)
          if (!pai || pai.source === "user" || alvo.has(pai.id)) break
          alvo.add(pai.id)
          atual = pai
        }
      }
      return [...alvo]
    },
    [scopedEntries],
  )

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const removeSelected = useCallback(async () => {
    const ids = comAncestrais([...selected])
    if (ids.length === 0) return
    await mediaApi.remove(ids)
    setSelected(new Set())
    setPreview((current) => (current && ids.includes(current.id) ? null : current))
    await refresh()
  }, [selected, refresh, comAncestrais])

  const cleanupScripts = useCallback(async () => {
    await mediaApi.cleanupScripts()
    setSelected(new Set())
    await refresh()
  }, [refresh])

  /** Abre o chat de origem e rola até a mensagem onde a imagem apareceu. */
  const openInChat = useCallback(async (entry: MediaEntry) => {
    if (!entry.sessionId) return
    const session = useSessionStore.getState().sessions.find((s) => s.id === entry.sessionId)
    if (!session) return
    const mode = session.mode === "code" ? "code" : "chat"
    setMode(mode)
    await useSessionStore.getState().selectSession(mode, session.id)
    setPreview(null)
    if (entry.messageId) {
      // espera o chat renderizar a lista antes de procurar a mensagem
      setTimeout(() => scrollToMessage(entry.messageId!), 400)
    }
  }, [setMode])

  /**
   * Clique no tile: imagem abre o lightbox; artefato abre a aba própria (o
   * lightbox é um <img>, e uma página renderizável precisa de iframe e
   * espaço). A aba nasce na sessão de ORIGEM do artefato quando ela é
   * conhecida — é lá que o card dele está na conversa.
   */
  const openEntry = useCallback(
    (entry: MediaEntry) => {
      const kind = mediaKind(entry)
      // Documento abre na aba do painel igual ao artefato: o preview dele é
      // HTML, e o lightbox só sabe mostrar <img>.
      if (kind !== "artifact" && kind !== "document") {
        setPreview(entry)
        // A cadeia é fixada na abertura: trocar de versão dentro do visor não
        // pode reescrever a lista por onde se está navegando.
        setPreviewChain(versionsByHead.get(entry.id) ?? null)
        return
      }
      const sessionId = entry.sessionId ?? useSessionStore.getState().activeIds[mode]
      if (!sessionId) return
      // Documento vivo abre no canvas de Markdown, arquivo pedido abre no
      // visualizador — quem decide e o openDocumentInPanel, para a galeria e o
      // card da conversa concordarem. Artefato continua na aba que renderiza a
      // pagina HTML.
      if (kind === "document") {
        void openDocumentInPanel(sessionId, entry.id, entry.name || entry.id)
        return
      }
      usePanelStore.getState().openArtifactTab(sessionId, entry.id, entry.name || entry.id)
    },
    [mode, versionsByHead],
  )

  const sourceFilters: SourceFilter[] = ["all", "user", "chat", "screenshot", "script", "batch"]
  const periodFilters: PeriodFilter[] = ["all", "today", "week", "month"]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-sidebar-border px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("media.searchPlaceholder")}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            title={t("media.refresh")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        {/* Escopo: cada chip é um jeito de a mídia pertencer a algo. O ícone
            é o que separa pasta da sidebar de repositório — os dois são
            "pasta" no nome, mas não são a mesma coisa. */}
        <div className="flex flex-wrap items-center gap-1">
          <ScopeChip
            active={scope === SCOPE_ALL}
            onClick={() => setScopeOverride(SCOPE_ALL)}
            label={t("media.scope.all")}
          />
          {activeSessionId && (
            <ScopeChip
              active={scope === SCOPE_SESSION}
              onClick={() => setScopeOverride(SCOPE_SESSION)}
              label={t("media.scope.session")}
              Icon={MessageSquare}
            />
          )}
          {folderOptions.map((folder) => (
            <ScopeChip
              key={folder.id}
              active={scope === `${FOLDER_PREFIX}${folder.id}`}
              onClick={() => setScopeOverride(`${FOLDER_PREFIX}${folder.id}`)}
              label={folder.name}
              Icon={Folder}
            />
          ))}
          {projectOptions.map((p) => (
            <ScopeChip
              key={p.key}
              active={scope === `${PROJECT_PREFIX}${p.key}`}
              onClick={() => setScopeOverride(`${PROJECT_PREFIX}${p.key}`)}
              label={p.label}
              Icon={FolderGit2}
            />
          ))}
          {hasLoose && (
            <ScopeChip
              active={scope === SCOPE_LOOSE}
              onClick={() => setScopeOverride(SCOPE_LOOSE)}
              label={t("media.scope.loose")}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {sourceFilters.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSource(value)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                source === value
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50",
              )}
            >
              {t(`media.source.${value}`)}
            </button>
          ))}
          <span className="mx-1 h-3 w-px bg-sidebar-border" />
          {periodFilters.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setPeriod(value)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                period === value
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50",
              )}
            >
              {t(`media.period.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-sidebar-border bg-sidebar-accent/40 px-3 py-1.5">
          <span className="text-xs text-sidebar-foreground">
            {t("media.selectedCount", { count: selected.size })}
          </span>
          <button
            type="button"
            onClick={() => void removeSelected()}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="size-3" />
            {t("media.delete")}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("media.loading")}</p>
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("media.empty")}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {visible.map((entry) => (
              <Thumb
                key={entry.id}
                entry={entry}
                selected={selected.has(entry.id)}
                selecting={selected.size > 0}
                onToggle={() => toggle(entry.id)}
                onOpen={() => openEntry(entry)}
                versions={versionsByHead.get(entry.id)?.length ?? 1}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <HardDriveIcon className="size-3" />
        <span>{t("media.usage", { count: usage.count, size: formatBytes(usage.bytes) })}</span>
        <button
          type="button"
          onClick={() => void cleanupScripts()}
          title={t("media.cleanupScriptsHint")}
          className="ml-auto rounded-md px-2 py-0.5 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          {t("media.cleanupScripts")}
        </button>
      </div>

      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (open) return
          setPreview(null)
          setPreviewChain(null)
        }}
      >
        <DialogContent className="max-w-5xl p-2">
          <DialogTitle className="sr-only">{preview?.name ?? preview?.id ?? ""}</DialogTitle>
          {preview && (
            <>
              <img
                src={`orbit-media://${preview.id}`}
                alt={preview.name ?? preview.id}
                className="max-h-[76vh] w-full rounded-md object-contain"
              />
              {previewChain && previewChain.length > 1 && (
                <div className="flex items-center gap-1.5 overflow-x-auto px-1 pt-1">
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t("media.versions", { count: previewChain.length })}
                  </span>
                  {previewChain.map((version, index) => (
                    <button
                      key={version.id}
                      type="button"
                      onClick={() => setPreview(version)}
                      title={`${index + 1}/${previewChain.length}`}
                      className={cn(
                        "relative size-10 shrink-0 overflow-hidden rounded border transition-colors",
                        version.id === preview.id
                          ? "border-primary ring-1 ring-primary"
                          : "border-sidebar-border hover:border-ring",
                      )}
                    >
                      <img
                        src={`orbit-media://${version.id}`}
                        alt={`${index + 1}`}
                        className="size-full object-cover"
                      />
                    </button>
                  ))}
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t("media.currentVersion")}
                  </span>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 px-1 pb-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{preview.name || preview.id}</span>
                <span>·</span>
                <span>{t(`media.source.${preview.source}`)}</span>
                <span>·</span>
                <span>{formatDate(preview.createdAt, i18n.language)}</span>
                {preview.width && preview.height && (
                  <>
                    <span>·</span>
                    <span>{preview.width}×{preview.height}</span>
                  </>
                )}
                <span>·</span>
                <span>{formatBytes(preview.size)}</span>
                <div className="ml-auto flex items-center gap-1">
                  {preview.sessionId && (
                    <button
                      type="button"
                      onClick={() => void openInChat(preview)}
                      className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent hover:text-accent-foreground"
                    >
                      <MessageSquare className="size-3" />
                      {t("media.openInChat")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      // Apagar a versão atual leva os degraus dela junto: eles
                      // só existiam como caminho até esta imagem.
                      await mediaApi.remove(comAncestrais([preview.id]))
                      setPreview(null)
                      setPreviewChain(null)
                      await refresh()
                    }}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-3" />
                    {t("media.delete")}
                  </button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
