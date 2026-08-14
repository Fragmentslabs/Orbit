import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, HardDriveIcon, ImageOff, MessageSquare, RefreshCw, Search, Trash2, X } from "lucide-react"
import type { MediaEntry, MediaSource } from "@shared/media"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { mediaApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"

/**
 * Galeria de mídia: página dedicada (aba do painel direito) com as imagens
 * que o agente produziu — show_image, screenshots e capturas de
 * scripts/lotes — e as prints coladas pelo usuário. Lê o registry do main
 * (orbit-data/media/index.json).
 *
 * Escopada por modo: no modo chat mostra só mídia de sessões de chat; no
 * modo código, só de sessões de código.
 *
 * Não é um card no chat: aqui o usuário revisita, abre no chat de origem,
 * exclui em lote e enxerga o espaço em disco.
 */

type SourceFilter = "all" | MediaSource
type PeriodFilter = "all" | "today" | "week" | "month"

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

function Thumb({ entry, selected, selecting, onToggle, onOpen }: {
  entry: MediaEntry
  selected: boolean
  selecting: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const [failed, setFailed] = useState(false)
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
        {failed ? (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageOff className="size-4" />
          </div>
        ) : (
          <img
            src={`orbit-media://${entry.id}`}
            alt={entry.name ?? entry.id}
            loading="lazy"
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        )}
      </button>
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

export function MediaGallery() {
  const { t, i18n } = useTranslation()
  const { mode, setMode } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const [entries, setEntries] = useState<MediaEntry[]>([])
  const [usage, setUsage] = useState({ count: 0, bytes: 0 })
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<SourceFilter>("all")
  const [period, setPeriod] = useState<PeriodFilter>("all")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<MediaEntry | null>(null)
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

  /** Sessões do modo atual — escopo da galeria (chat mostra só chat, etc). */
  const modeSessionIds = useMemo(
    () => new Set(sessions.filter((s) => s.mode === mode).map((s) => s.id)),
    [sessions, mode],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const since = period === "all" ? 0 : Date.now() - PERIOD_MS[period]
    return entries.filter((entry) => {
      if (source !== "all" && entry.source !== source) return false
      // Entradas sem sessão conhecida (órfãs do backfill) aparecem nos dois
      // modos; com sessão, só no modo da sessão.
      if (entry.sessionId && !modeSessionIds.has(entry.sessionId)) return false
      if (entry.createdAt < since) return false
      if (!needle) return true
      return `${entry.name ?? ""} ${entry.taskId ?? ""} ${entry.id}`.toLowerCase().includes(needle)
    })
  }, [entries, source, period, query, modeSessionIds])

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const removeSelected = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    await mediaApi.remove(ids)
    setSelected(new Set())
    setPreview((current) => (current && ids.includes(current.id) ? null : current))
    await refresh()
  }, [selected, refresh])

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
                onOpen={() => setPreview(entry)}
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

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-5xl p-2">
          <DialogTitle className="sr-only">{preview?.name ?? preview?.id ?? ""}</DialogTitle>
          {preview && (
            <>
              <img
                src={`orbit-media://${preview.id}`}
                alt={preview.name ?? preview.id}
                className="max-h-[76vh] w-full rounded-md object-contain"
              />
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
                      await mediaApi.remove([preview.id])
                      setPreview(null)
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
