import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { LucideIcon } from "lucide-react"
import { AudioLines, CheckIcon, Folder, FolderGit2, Inbox, LayoutGrid, Pause, Terminal, ChevronDown, ChevronLeft, ChevronRight, CodeXml, FileText, HardDriveIcon, ImageOff, Layers, MessageSquare, RefreshCw, Search, Trash2, X } from "lucide-react"
import { assetUrl, mediaKind, mediaMime, thumbUrl, MEDIA_DND_MIME, type MediaEntry, type MediaKind } from "@shared/media"
import { folderKey, normalizeFolderName } from "@shared/chat"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { Input } from "@/components/ui/input"
import { artifactApi, mediaApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"
import { useTheme } from "@/components/theme-provider"
import { KIND_ICON } from "@/src/lib/media-kind-icon"
import { openMediaEntryInPanel } from "@/src/lib/open-media-entry"
import { useWorkspace } from "@/lib/workspace-context"
import { useViewScope } from "@/src/stores/view-scope-store"
import type { ViewScope } from "@/src/stores/view-scope-store"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { expandToGroups, groupMediaByRoot } from "@/src/lib/media-groups"
import { scrollToMessage } from "@/src/lib/message-jump"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Media gallery: dedicated page (right panel tab) with what the agent
 * produced — images (show_image, screenshots, captures from scripts/batches),
 * HTML artifacts (create_artifact) and the screenshots pasted by the user. It reads the
 * main process registry (orbit-data/media/index.json), which indexes both types:
 * the artifact file lives in orbit-data/artifacts, and the registry points
 * to it — nothing is duplicated.
 *
 * Scoped by mode: in chat mode it shows only media from chat sessions; in
 * code mode, only from code sessions.
 *
 * It is not a card in the chat: here the user revisits, opens in the origin chat,
 * deletes in bulk and sees the disk usage.
 */

/** Filter by TYPE: what the grid shows — image, page, document, audio,
 *  motion piece or video. */
type KindFilter = "all" | MediaKind

/**
 * SCOPE of the gallery — a single filter, with four natures.
 *
 * There are four because there are four ways for the media to belong to something: the
 * conversation in which it was born, the sidebar folder of that conversation, the repository
 * it was working in, or none of that. Splitting it into several filters would make the
 * user combine scopes that do not cross.
 *
 * The folder comes from the SESSION, not from the record: only documents record `folderId`, and the
 * filter needs to count for image and artifact too.
 */
const SCOPE_ALL = "all"
const SCOPE_SESSION = "session"
/** Media that belongs neither to a folder nor to a repository — the one of a loose chat. */
const SCOPE_LOOSE = "__loose__"
const FOLDER_PREFIX = "folder:"
const PROJECT_PREFIX = "project:"

/**
 * Design canvas and motion piece are APP ASSETS, not conversation media:
 * the folder lives in Orbit's storage and stays valid outside the conversation
 * that created it. That is why the SCOPE (folder/repository/conversation) does not hide them —
 * otherwise the design folder disappears from the tab whenever the scope falls on another conversation.
 * What still hides them is the TYPE filter, which is an explicit choice of whoever
 * looks ("images only" does not show a design canvas).
 */
function isAppAsset(entry: MediaEntry): boolean {
  const kind = mediaKind(entry)
  return kind === "design" || kind === "motion" || kind === "slides"
}

/** Backfill runs once per renderer process — it is idempotent in the main process. */
let backfillDone = false

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 754300 → "12:34"; past one hour: "1:02:03". */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

function formatDate(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Icon + name, the same in the select's trigger and in its list. */
function FilterLabel({ Icon, label }: { Icon: LucideIcon; label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </span>
  )
}

function Thumb({ entry, selected, selecting, onToggle, onOpen, versions = 1 }: {
  entry: MediaEntry
  selected: boolean
  selecting: boolean
  onToggle: () => void
  onOpen: () => void
  /** How many images exist in the chain this tile represents. */
  versions?: number
}) {
  const [failed, setFailed] = useState(false)
  const { t } = useTranslation()
  const { theme } = useTheme()
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  // An artifact without a thumbnail (capture failed) or a broken image falls into the icon —
  // the tile stays clickable, the asset still exists.
  // The living document has one cover per theme: the grid one is the current theme's, so
  // the tile is not the only white thing on a dark screen.
  const preview = thumbUrl(entry, isDark)
  const kind = mediaKind(entry)
  const isArtifact = kind === "artifact"
  const isDocument = kind === "document"
  const isAudio = kind === "audio"
  const FallbackIcon = isAudio ? AudioLines : isDocument ? FileText : isArtifact ? CodeXml : ImageOff
  // Audio plays in the tile itself: there is nothing to see in a viewer, and opening a tab
  // only to listen would be one step too many.
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(() => () => audioRef.current?.pause(), [])
  const togglePlay = () => {
    if (!audioRef.current) {
      const audio = new Audio(assetUrl(entry))
      audio.onended = () => setPlaying(false)
      audio.onpause = () => setPlaying(false)
      audio.onplay = () => setPlaying(true)
      audioRef.current = audio
    }
    const audio = audioRef.current
    if (audio.paused) void audio.play().catch(() => setPlaying(false))
    else audio.pause()
  }
  // Badge per type — only the ICON, and now in EVERY tile. The grid mixes image,
  // page, document, audio and motion piece, and the click does something different
  // in each one; without the badge the difference is invisible. Writing "HTML", "WAV" or
  // "PDF/DOCX" spent the tile width to repeat what the drawing already says —
  // whoever wants the full name hovers.
  const KindIcon = KIND_ICON[kind]

  return (
    <div
      className={cn(
        "group relative aspect-square overflow-hidden rounded-xl border bg-muted/30 transition-colors",
        selected ? "border-primary ring-1 ring-primary" : "border-sidebar-border hover:border-ring",
      )}
    >
      <button
        type="button"
        draggable
        onClick={() => (selecting ? onToggle() : isAudio ? togglePlay() : onOpen())}
        className="block size-full cursor-pointer"
        onDragStart={(event) => {
          // EVERY tile — image, video, motion, artifact, document, audio — is
          // draggable to the composer AS AN ATTACHMENT: the payload carries only the
          // IDENTITY of the item (id, name, type and a preview URL). The attachment
          // stays being a REFERENCE to the file that is already here — nothing is
          // copied, and the drop pastes no path as text into the input.
          // `draggable` is mandatory in the tiles without <img> (audio falls into the icon).
          event.dataTransfer.setData(
            MEDIA_DND_MIME,
            JSON.stringify({
              id: entry.id,
              name: entry.name || entry.id,
              kind,
              mime: mediaMime(entry),
              url: thumbUrl(entry, isDark) ?? assetUrl(entry),
            }),
          )
          event.dataTransfer.setData("text/plain", assetUrl(entry))
          event.dataTransfer.effectAllowed = "copy"
        }}
      >
        {failed || !preview ? (
          <div className={cn("flex size-full items-center justify-center", playing ? "text-primary" : "text-muted-foreground")}>
            {isAudio && playing ? <Pause className="size-5" /> : <FallbackIcon className={isAudio ? "size-5" : "size-4"} />}
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
      {/* Type badge and version stack in the SAME corner. Now that every tile has a
          badge, the previous `!badge` would hide the stack precisely in the image — which
          is where it appears most. */}
      <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1">
        {/* Edit stack: the tile is the current version, and the stack says there is
            history behind it — without it, the collapse would look like a loss. */}
        {versions > 1 && (
          <span className="flex items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
            <Layers className="size-3" />
            {versions}
          </span>
        )}
        <span
          title={t(`media.kind.${kind}`)}
          className="flex items-center rounded bg-background/85 px-1 py-0.5 text-foreground"
        >
          <KindIcon className="size-3" />
        </span>
      </span>
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3">
        <Truncate text={entry.name || entry.id}>
          <p className="min-w-0 truncate text-[10px] font-medium text-white">{entry.name || entry.id}</p>
        </Truncate>
        {kind === "video" && entry.durationMs ? (
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-white/90">{formatDuration(entry.durationMs)}</span>
        ) : null}
      </div>
    </div>
  )
}

export function MediaGallery() {
  const { t, i18n } = useTranslation()
  const { mode, setMode, folders } = useWorkspace()
  // The page's own Chat | Code | All toggle; until it is chosen it follows the workspace mode.
  const [viewScope, setViewScope] = useViewScope("media", mode)
  const sessions = useSessionStore((s) => s.sessions)
  /** Sidebar folders (grouping of conversations) — different from the workspace working
   *  folders, which are repositories. */
  const sidebarFolders = useSessionStore((s) => s.folders)
  const activeSessionId = useSessionStore((s) => s.activeIds[mode])
  const [entries, setEntries] = useState<MediaEntry[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [usage, setUsage] = useState({ count: 0, bytes: 0 })
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState<KindFilter>("all")
  /** Explicit user choice; null = follows the default of the current context. */
  const [scopeOverride, setScopeOverride] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<MediaEntry | null>(null)
  /** Versions of the open image, from the oldest to the current one. */
  const [previewChain, setPreviewChain] = useState<MediaEntry[] | null>(null)
  /**
   * Deletion pending confirmation. Deleting media has no undo, and since
   * a grid item started representing a group, one click could take
   * versions the person did not even know were there — hence the extra step,
   * and hence it saying how many there are.
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
      // First opening: it indexes the images that existed before the registry.
      if (!backfillDone) {
        backfillDone = true
        try {
          await mediaApi.backfill()
        } catch {
          // the registry is best-effort — the list still works
        }
      }
      await refresh()
    })()
    return () => { mounted.current = false }
  }, [refresh])

  // Artifact rewritten with the gallery open: the record changes (revision, size,
  // title) and the thumbnail is recaptured with the SAME file name. Only the
  // refresh brings the new revision, which is what breaks the tie in the thumbnail URL.
  useEffect(() => artifactApi.onUpdated(() => void refresh()), [refresh])

  // The collection changed with the panel open (the agent generated or deleted an image in
  // the middle of the conversation). The breathing room groups the burst of a whole turn into a
  // single reload, instead of one per file.
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

  /** Sessions of the current mode — gallery scope (chat shows only chat, etc). */
  const modeSessionIds = useMemo(
    () => new Set(sessions.filter((s) => viewScope === "all" || s.mode === viewScope).map((s) => s.id)),
    [sessions, viewScope],
  )

  /**
   * Project of an entry: the directory of the session that originated it, normalized
   * with the SAME rule as the sidebar folders (folderKey/normalizeFolderName).
   * An entry with no known session (orphan from the backfill) or a session without a directory
   * (chat mode) has no project.
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
   * Sidebar folder of an entry, through the session that originated it. An orphan entry
   * (backfill) or a conversation outside a folder has none.
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

  /** Entries in the scope of the current mode (it applies the session filter only once). */
  const scopedEntries = useMemo(
    () => entries.filter((entry) => !entry.sessionId || modeSessionIds.has(entry.sessionId)),
    [entries, modeSessionIds],
  )

  /** Sidebar folders with media in the scope — the filter chips. */
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

  /** Projects with media in the scope — the filter chips. */
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
    () => scopedEntries.some((entry) => !isAppAsset(entry) && !folderOf(entry) && !projectOf(entry)),
    [scopedEntries, folderOf, projectOf],
  )

  /** Does an entry fall in this scope? It is the single rule — filter, default and chips
   *  all ask here, so there is no way for them to diverge. */
  const matchesScope = useCallback(
    (entry: MediaEntry, value: string): boolean => {
      if (value === SCOPE_ALL) return true
      // Origin session OR a linked session — a fork inherits what already
      // existed in the original conversation (see linkMediaSessions, in the main process).
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
   * The scope the gallery opens with when the user has not chosen yet.
   *
   * From the most specific the context offers to the broadest: the sidebar folder of the
   * conversation, otherwise the repository it works in, otherwise — in a
   * LOOSE CHAT, which belongs to neither — the conversation itself.
   *
   * Each candidate only counts if it has media: opening the gallery empty would hide
   * everything that exists, and the user would have no way of knowing that the filter is what is
   * tight.
   */
  const defaultScope = useMemo(() => {
    // The default scope is chosen by what is CONVERSATION media: a design
    // canvas cannot decide the scope, otherwise the gallery would open in an empty
    // filter just because it exists.
    const has = (value: string) => scopedEntries.some((entry) => !isAppAsset(entry) && matchesScope(entry, value))
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

  /** Values that exist now — the override dies when it leaves the scene (e.g. the
   *  user switches mode and that folder has no media here). */
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

  /** All derived: no setState in an effect. */
  const scope = useMemo(
    () => (scopeOverride && scopeValues.has(scopeOverride) ? scopeOverride : defaultScope),
    [scopeOverride, scopeValues, defaultScope],
  )

  /**
   * What the grid shows: one entry per origin photo, with its versions
   * behind it. The rule (and why it is by the root, and not by the tip) lives in
   * media-groups.ts, along with the tests.
   */
  const { visible, versionsByHead } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtrados = scopedEntries.filter((entry) => {
      // Type is the most direct filter that exists here ("where are the pieces?"): it goes
      // along with the scope, before the date, because it is usually the one that is wrong
      // when the grid looks empty.
      if (kind !== "all" && mediaKind(entry) !== kind) return false
      if (!isAppAsset(entry) && !matchesScope(entry, scope)) return false
      if (!needle) return true
      return `${entry.name ?? ""} ${entry.taskId ?? ""} ${entry.id}`.toLowerCase().includes(needle)
    })
    const { covers, versions } = groupMediaByRoot(scopedEntries, filtrados)
    return { visible: covers, versionsByHead: versions }
  }, [scopedEntries, kind, query, scope, matchesScope])

  /** Deleting a grid item takes its group — see expandToGroups. */
  const withVersions = useCallback(
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

  /** Opens the origin chat and scrolls to the message where the image appeared. */
  const openInChat = useCallback(async (entry: MediaEntry) => {
    if (!entry.sessionId) return
    const session = useSessionStore.getState().sessions.find((s) => s.id === entry.sessionId)
    if (!session) return
    const mode = session.mode === "code" ? "code" : "chat"
    setMode(mode)
    await useSessionStore.getState().selectSession(mode, session.id)
    setPreview(null)
    if (entry.messageId) {
      // waits for the chat to render the list before looking for the message
      setTimeout(() => void scrollToMessage(entry.messageId!), 400)
    }
  }, [setMode])

  /**
   * Click on the tile: an image opens the lightbox; an artifact opens its own tab (the
   * lightbox is an <img>, and a renderable page needs an iframe and
   * room). The tab is born in the panel that is ON SCREEN, and not in the origin
   * conversation's: opened there, it went to a hidden panel and the click seemed to
   * do nothing. Artifact and document of the gallery are read by their own id, without
   * depending on the conversation in which they were born.
   */
  const openEntry = useCallback(
    (entry: MediaEntry) => {
      const kind = mediaKind(entry)
      // Audio plays in the tile itself (see Thumb) — there is no viewer for it.
      if (kind === "audio") return
      // Pieces with a tab of their own (motion, design, slides, document, artifact) open in the
      // panel that is ON SCREEN, and not in the origin conversation's: opened there, the tab went
      // to a hidden panel and the click seemed to do nothing.
      const bucketKey = useSessionStore.getState().activeIds[mode] ?? ORPHAN_KEY
      if (openMediaEntryInPanel(entry, bucketKey)) return
      setPreview(entry)
      // The chain is fixed on opening: switching version inside the viewer cannot
      // rewrite the list one is navigating through.
      setPreviewChain(versionsByHead.get(entry.id) ?? null)
    },
    [mode, versionsByHead],
  )

  /** Position of the open version inside the stack, for the viewer arrows. */
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

  /** Deletes what was confirmed and closes whatever is open. */
  const runDelete = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      // The tabs of the pieces that go away close along: the folder disappears, and a tab
      // open on a deleted motion would only show an error.
      const motionIds = entries.flatMap((e) => (ids.includes(e.id) && e.motionId ? [e.motionId] : []))
      const designIds = entries.flatMap((e) => (ids.includes(e.id) && e.designId ? [e.designId] : []))
      const slidesIds = entries.flatMap((e) => (ids.includes(e.id) && e.slidesId ? [e.slidesId] : []))
      await mediaApi.remove(ids)
      usePanelStore.getState().closeMotionTabs(motionIds)
      usePanelStore.getState().closeDesignTabs(designIds)
      usePanelStore.getState().closeSlidesTabs(slidesIds)
      setConfirmDelete(null)
      setSelected(new Set())
      setPreview((current) => (current && ids.includes(current.id) ? null : current))
      setPreviewChain(null)
      await refresh()
    },
    [entries, refresh],
  )

  const selectedDesignCount = useMemo(
    () => entries.filter((e) => selected.has(e.id) && mediaKind(e) === "design").length,
    [entries, selected],
  )

  const selectedMotionCount = useMemo(
    () => entries.filter((e) => selected.has(e.id) && mediaKind(e) === "motion").length,
    [entries, selected],
  )

  const selectedSlidesCount = useMemo(
    () => entries.filter((e) => selected.has(e.id) && mediaKind(e) === "slides").length,
    [entries, selected],
  )

  const activeFilters = (kind !== "all" ? 1 : 0) + (scope !== defaultScope ? 1 : 0)
  const kindFilters: KindFilter[] = ["all", ...(Object.keys(KIND_ICON) as MediaKind[])]

  /** The "where" select: everything, this chat, the loose ones, then folders and repositories. */
  const scopeOptions = [
    { value: SCOPE_ALL, label: t("media.scope.all"), Icon: Layers },
    ...(activeSessionId ? [{ value: SCOPE_SESSION, label: t("media.scope.session"), Icon: MessageSquare }] : []),
    ...(hasLoose ? [{ value: SCOPE_LOOSE, label: t("media.scope.loose"), Icon: Inbox }] : []),
    ...folderOptions.map((f) => ({ value: `${FOLDER_PREFIX}${f.id}`, label: f.name, Icon: Folder })),
    ...projectOptions.map((p) => ({ value: `${PROJECT_PREFIX}${p.key}`, label: p.label, Icon: FolderGit2 })),
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="@container flex flex-col gap-2.5 px-4 pt-3 pb-2.5">
        {/* Same look as the sidebar's Chat/Code tabs. */}
        <Tabs value={viewScope} onValueChange={(value) => setViewScope(value as ViewScope)}>
          <TabsList className="w-full rounded-xl group-data-horizontal/tabs:h-9">
            <TabsTrigger value="chat" className="flex-1 gap-2 rounded-lg px-2">
              <MessageSquare className="size-4" />
              {t("viewScope.chat")}
            </TabsTrigger>
            <TabsTrigger value="code" className="flex-1 gap-2 rounded-lg px-2">
              <Terminal className="size-4" />
              {t("viewScope.code")}
            </TabsTrigger>
            <TabsTrigger value="all" className="flex-1 gap-2 rounded-lg px-2">
              <Layers className="size-4" />
              {t("viewScope.all")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("media.searchPlaceholder")}
              className="h-9 pl-9 text-xs"
            />
          </div>
          <Hint label={t("media.refresh")}>
            <button
              type="button"
              onClick={() => void refresh()}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </Hint>
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          className="flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t(filtersOpen ? "media.filters.hide" : "media.filters.show")}
          {/* Hidden filters still filter: say how many are on, or an empty grid has no explanation. */}
          {!filtersOpen && activeFilters > 0 && <span className="text-foreground">({activeFilters})</span>}
          <ChevronDown className={cn("size-3 transition-transform", filtersOpen && "rotate-180")} />
        </button>
        {filtersOpen && (
          <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
            <Select value={kind} onValueChange={(value) => setKind((value ?? "all") as KindFilter)}>
              <SelectTrigger className="h-9 w-full px-3 text-xs" aria-label={t("media.filters.kind")}>
                <SelectValue>
                  <FilterLabel Icon={kind === "all" ? LayoutGrid : KIND_ICON[kind]} label={t(`media.kind.${kind}`)} />
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {kindFilters.map((value) => (
                  <SelectItem key={value} value={value}>
                    <FilterLabel Icon={value === "all" ? LayoutGrid : KIND_ICON[value]} label={t(`media.kind.${value}`)} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={scope} onValueChange={(value) => setScopeOverride(value ?? SCOPE_ALL)}>
              <SelectTrigger className="h-9 w-full px-3 text-xs" aria-label={t("media.filters.scope")}>
                <SelectValue>
                  {(() => {
                    const current = scopeOptions.find((o) => o.value === scope)
                    return current ? <FilterLabel Icon={current.Icon} label={current.label} /> : null
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {scopeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <FilterLabel Icon={option.Icon} label={option.label} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
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
          <Hint label={t("media.clearSelection")}>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="ml-auto flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent"
            >
              <X className="size-3" />
            </button>
          </Hint>
        </div>
      )}

      <div className="@container min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("media.loading")}</p>
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("media.empty")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
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
        <Hint label={t("media.cleanupScriptsHint")}>
          <button
            type="button"
            onClick={() => void cleanupScripts()}
            className="ml-auto rounded-md px-2 py-0.5 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
       
           {t("media.cleanupScripts")}
        </button>
        </Hint>
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
                {mediaKind(preview) === "video" && preview.videoUrl ? (
                  <video
                    key={preview.id}
                    src={preview.videoUrl}
                    controls
                    autoPlay
                    className="max-h-[76vh] w-full rounded-md bg-black object-contain"
                  />
                ) : (
                  <img
                    src={`orbit-media://${preview.id}`}
                    alt={preview.name ?? preview.id}
                    className="max-h-[76vh] w-full rounded-md object-contain"
                  />
                )}
                {/* Arrows only when there is somewhere to go: in a photo without history
                    they would be two dead buttons over the image. */}
                {previewChain && previewIndex > 0 && (
                  <Hint label={t("media.previousVersion")}>
                    <button
                      type="button"
                      onClick={() => stepVersion(-1)}
                      className="absolute left-2 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground shadow-md transition-colors hover:bg-background"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                  </Hint>
                )}
                {previewChain && previewIndex >= 0 && previewIndex < previewChain.length - 1 && (
                  <Hint label={t("media.nextVersion")}>
                    <button
                      type="button"
                      onClick={() => stepVersion(1)}
                      className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground shadow-md transition-colors hover:bg-background"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </Hint>
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
                      {/* The number is how the person talks about the version ("go back to
                          v2"), so it stays visible, not only in the title. */}
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
                {preview.credit && (
                  
                    <Truncate>
                      <span title={preview.credit.attribution} className="truncate">
                      {preview.credit.license}
                      {preview.credit.creator ? ` · ${preview.credit.creator}` : ""}
                    </span>
                    </Truncate>
                )}
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

      {/* Deletion of the SELECTION: a grid item is the whole group, so the
          number that matters is not how many tiles were marked, but how many
          files are going away. */}
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
                files: withVersions([...selected]).length,
              })}
              {selectedMotionCount > 0 && ` ${t("media.confirmDelete.motionNote", { count: selectedMotionCount })}`}
              {selectedDesignCount > 0 && ` ${t("media.confirmDelete.designNote", { count: selectedDesignCount })}`}
              {selectedSlidesCount > 0 && ` ${t("media.confirmDelete.slidesNote", { count: selectedSlidesCount })}`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runDelete(withVersions([...selected]))}
            >
              {t("media.confirmDelete.confirmAll")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deletion in the VIEWER: here the person is looking at a specific version,
          so the two exits stay explicit instead of one being guessed. */}
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
                onClick={() => void runDelete(withVersions(preview ? [preview.id] : []))}
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
