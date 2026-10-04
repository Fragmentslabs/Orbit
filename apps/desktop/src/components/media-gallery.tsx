import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, ChevronDown, ChevronLeft, ChevronRight, CodeXml, FileText, Filter, Folder, FolderGit2, HardDriveIcon, ImageOff, Layers, MessageSquare, RefreshCw, Search, Trash2, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { mediaKind, thumbUrl, type MediaEntry, type MediaSource } from "@shared/media"
import { folderKey, normalizeFolderName } from "@shared/chat"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { artifactApi, mediaApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useTheme } from "@/components/theme-provider"
import { openDocumentInPanel } from "@/src/lib/open-document"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import { expandToGroups, groupMediaByRoot } from "@/src/lib/media-groups"

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

/**
 * Pastas e repositórios num dropdown, e não um chip por item: com um projeto
 * ativo a barra de escopo virava uma parede de botões. "Everything" e "In
 * this chat" continuam como chips — são sempre as duas opções mais usadas —
 * e o resto (pasta específica, repositório específico, soltos) mora aqui.
 */
function ScopeFilterMenu({
  scope,
  folderOptions,
  projectOptions,
  hasLoose,
  onSelect,
}: {
  scope: string
  folderOptions: { id: string; name: string }[]
  projectOptions: { key: string; label: string }[]
  hasLoose: boolean
  onSelect: (value: string) => void
}) {
  const { t } = useTranslation()
  if (folderOptions.length === 0 && projectOptions.length === 0 && !hasLoose) return null

  const activeFolder = folderOptions.find((f) => scope === `${FOLDER_PREFIX}${f.id}`)
  const activeProject = projectOptions.find((p) => scope === `${PROJECT_PREFIX}${p.key}`)
  const activeLoose = hasLoose && scope === SCOPE_LOOSE
  const active = !!activeFolder || !!activeProject || activeLoose
  const ActiveIcon = activeFolder ? Folder : activeProject ? FolderGit2 : Filter
  const label = activeFolder?.name ?? activeProject?.label ?? (activeLoose ? t("media.scope.loose") : t("media.scope.filters"))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex max-w-40 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/50",
        )}
      >
        <ActiveIcon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        {hasLoose && (
          <DropdownMenuItem onClick={() => onSelect(SCOPE_LOOSE)}>
            {t("media.scope.loose")}
          </DropdownMenuItem>
        )}
        {folderOptions.length > 0 && (
          <>
            {hasLoose && <DropdownMenuSeparator />}
            {/* O rótulo precisa de um grupo: fora de um Menu.Group o Base UI derruba a tela ao abrir. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-[10px] text-muted-foreground">
                {t("media.scope.folders")}
              </DropdownMenuLabel>
              {folderOptions.map((folder) => (
                <DropdownMenuItem key={folder.id} onClick={() => onSelect(`${FOLDER_PREFIX}${folder.id}`)}>
                  <Folder className="size-3.5" />
                  <span className="truncate">{folder.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {projectOptions.length > 0 && (
          <>
            {(hasLoose || folderOptions.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-[10px] text-muted-foreground">
                {t("media.scope.projects")}
              </DropdownMenuLabel>
              {projectOptions.map((project) => (
                <DropdownMenuItem key={project.key} onClick={() => onSelect(`${PROJECT_PREFIX}${project.key}`)}>
                  <FolderGit2 className="size-3.5" />
                  <span className="truncate">{project.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  /**
   * Exclusão pendente de confirmação. Apagar mídia não tem desfazer, e desde
   * que um item da grade passou a representar um grupo, um clique podia levar
   * versões que a pessoa nem sabia que estavam ali — por isso o passo a mais,
   * e por isso ele diz quantas são.
   */
  const [confirmDelete, setConfirmDelete] = useState<"selection" | "viewer" | null>(null)
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

  // Acervo mudou com o painel aberto (o agente gerou ou apagou uma imagem no
  // meio da conversa). O respiro agrupa a rajada de um turno inteiro numa
  // recarga só, em vez de uma por arquivo.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = mediaApi.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [refresh])

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
      // Sessão de origem OU uma sessão vinculada — um fork herda o que já
      // existia na conversa original (ver linkMediaSessions, no main).
      if (value === SCOPE_SESSION) {
        return (
          !!activeSessionId &&
          (entry.sessionId === activeSessionId || !!entry.linkedSessionIds?.includes(activeSessionId))
        )
      }
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
   * O que a grade mostra: uma entrada por foto de origem, com as versões dela
   * atrás. A regra (e o porquê de ser pela raiz, e não pela ponta) mora em
   * media-groups.ts, junto dos testes.
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
    const { covers, versions } = groupMediaByRoot(scopedEntries, filtrados)
    return { visible: covers, versionsByHead: versions }
  }, [scopedEntries, source, period, query, scope, matchesScope])

  /** Apagar um item da grade leva o grupo dele — ver expandToGroups. */
  const comVersoes = useCallback(
    (ids: string[]) => expandToGroups(ids, scopedEntries),
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

  /** Posição da versão aberta dentro da pilha, para as setas do visor. */
  const previewIndex = useMemo(
    () => (preview && previewChain ? previewChain.findIndex((v) => v.id === preview.id) : -1),
    [preview, previewChain],
  )
  const stepVersion = useCallback(
    (delta: number) => {
      if (!previewChain || previewIndex < 0) return
      const next = previewChain[previewIndex + delta]
      if (next) setPreview(next)
    },
    [previewChain, previewIndex],
  )

  /** Apaga o que foi confirmado e fecha o que estiver aberto. */
  const runDelete = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      await mediaApi.remove(ids)
      setConfirmDelete(null)
      setSelected(new Set())
      setPreview((current) => (current && ids.includes(current.id) ? null : current))
      setPreviewChain(null)
      await refresh()
    },
    [refresh],
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
        {/* Escopo: "Tudo" e "Neste chat" são os dois mais usados e ficam
            sempre visíveis; pasta/repositório/soltos — que podem ser muitos —
            vão no dropdown ao lado, senão a barra vira uma parede de chips. */}
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
          <ScopeFilterMenu
            scope={scope}
            folderOptions={folderOptions}
            projectOptions={projectOptions}
            hasLoose={hasLoose}
            onSelect={(value) => setScopeOverride(value)}
          />
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
            onClick={() => setConfirmDelete("selection")}
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
              <div className="relative">
                <img
                  src={`orbit-media://${preview.id}`}
                  alt={preview.name ?? preview.id}
                  className="max-h-[76vh] w-full rounded-md object-contain"
                />
                {/* Setas só quando há para onde ir: numa foto sem histórico
                    elas seriam dois botões mortos em cima da imagem. */}
                {previewChain && previewIndex > 0 && (
                  <button
                    type="button"
                    onClick={() => stepVersion(-1)}
                    title={t("media.previousVersion")}
                    className="absolute left-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 text-foreground shadow-md transition-colors hover:bg-background"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                )}
                {previewChain && previewIndex >= 0 && previewIndex < previewChain.length - 1 && (
                  <button
                    type="button"
                    onClick={() => stepVersion(1)}
                    title={t("media.nextVersion")}
                    className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 text-foreground shadow-md transition-colors hover:bg-background"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                )}
                {previewChain && previewIndex >= 0 && (
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2 py-0.5 text-[11px] text-foreground shadow-md">
                    v{previewIndex + 1}/{previewChain.length}
                  </span>
                )}
              </div>
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
                      title={`v${index + 1} de ${previewChain.length}`}
                      className={cn(
                        "relative size-10 shrink-0 overflow-hidden rounded border transition-colors",
                        version.id === preview.id
                          ? "border-primary ring-1 ring-primary"
                          : "border-sidebar-border hover:border-ring",
                      )}
                    >
                      <img
                        src={`orbit-media://${version.id}`}
                        alt={`v${index + 1}`}
                        className="size-full object-cover"
                      />
                      {/* O numero e como a pessoa fala da versao ("volta pra
                          v2"), entao ele fica visivel, nao so no title. */}
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[9px] leading-tight text-white">
                        v{index + 1}
                      </span>
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
                    onClick={() => setConfirmDelete("viewer")}
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

      {/* Exclusão da SELEÇÃO: um item da grade é o grupo inteiro, então o
          número que importa não é quantos tiles foram marcados, e sim quantos
          arquivos vão embora. */}
      <Dialog
        open={confirmDelete === "selection"}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("media.confirmDelete.title")}</DialogTitle>
            <DialogDescription>
              {t("media.confirmDelete.selection", {
                items: selected.size,
                files: comVersoes([...selected]).length,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runDelete(comVersoes([...selected]))}
            >
              {t("media.confirmDelete.confirmAll")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Exclusão no VISOR: aqui a pessoa está olhando uma versão específica,
          então as duas saídas ficam explícitas em vez de uma ser adivinhada. */}
      <Dialog
        open={confirmDelete === "viewer"}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("media.confirmDelete.title")}</DialogTitle>
            <DialogDescription>
              {previewChain && previewChain.length > 1
                ? t("media.confirmDelete.viewerChain", {
                    version: previewIndex + 1,
                    count: previewChain.length,
                  })
                : t("media.confirmDelete.viewerSingle")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:flex-col sm:items-stretch sm:gap-2">
            {previewChain && previewChain.length > 1 && (
              <Button
                variant="destructive"
                onClick={() => void runDelete(comVersoes(preview ? [preview.id] : []))}
              >
                {t("media.confirmDelete.allVersions", { count: previewChain.length })}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void runDelete(preview ? [preview.id] : [])}
            >
              {previewChain && previewChain.length > 1
                ? t("media.confirmDelete.onlyThis", { version: previewIndex + 1 })
                : t("media.delete")}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
