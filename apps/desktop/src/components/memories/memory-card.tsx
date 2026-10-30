import { memo, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, ArrowUpCircle, ExternalLink, FileText, Link2, Pencil, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import type { Memory } from "@shared/memory"
import { scopeOf } from "@shared/memory"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useMemoryStore } from "@/src/stores/memory-store"
import { useSessionStore } from "@/src/stores/session-store"
import { CATEGORY_LABEL, KIND_BADGE, KIND_COLOR, KIND_LABEL, canPromote } from "./meta"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/** How many links the card shows before referring to the editing panel. */
const MAX_RELATED_IN_CARD = 3

function formatDate(ts: number, locale: string) {
  return new Date(ts).toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" })
}

/** Draft per memory — it preserves edits when navigating between connected nodes. */
interface Draft {
  text: string
  tags: string
  weight: number
}

function draftOf(memory: Memory): Draft {
  return { text: memory.text, tags: memory.tags.join(", "), weight: memory.weight }
}

function isDirty(draft: Draft, memory: Memory): boolean {
  return (
    draft.text !== memory.text ||
    draft.tags !== memory.tags.join(", ") ||
    draft.weight !== memory.weight
  )
}

/**
 * Editing panel. Besides the fields, it mirrors the card metadata (type,
 * category, project, weight, uses, dates) and lists the connected nodes — clicking
 * one of them starts editing that node, without closing the dialog.
 *
 * The edits stay in a draft per id, so navigating from one node to another and
 * back does not lose what was typed.
 */
function EditDialog({ memory, open, onOpenChange }: {
  memory: Memory
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const update = useMemoryStore((s) => s.update)
  const index = useMemoryStore((s) => s.index)

  const [currentId, setCurrentId] = useState(memory.id)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  /** Nodes visited from the original one — it feeds the back button. */
  const [trail, setTrail] = useState<string[]>([])

  const byId = useMemo(() => new Map(index.map((m) => [m.id, m])), [index])
  const current = byId.get(currentId) ?? memory
  const draft = drafts[currentId] ?? draftOf(current)
  const related = current.relatedIds
    .map((id) => byId.get(id))
    .filter((m): m is Memory => m != null)

  // Reopening always starts from the card memory, with the drafts cleared.
  useEffect(() => {
    if (open) {
      setCurrentId(memory.id)
      setDrafts({})
      setTrail([])
    }
  }, [open, memory.id])

  const setDraft = (patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [currentId]: { ...draft, ...patch } }))

  const navigateTo = (id: string) => {
    setDrafts((prev) => ({ ...prev, [currentId]: draft }))
    setTrail((prev) => [...prev, currentId])
    setCurrentId(id)
  }

  const goBack = () => {
    setDrafts((prev) => ({ ...prev, [currentId]: draft }))
    setTrail((prev) => {
      const next = [...prev]
      const previous = next.pop()
      if (previous) setCurrentId(previous)
      return next
    })
  }

  /** Saves all the changed drafts, not only the focused node. */
  const saveAll = () => {
    const pending = { ...drafts, [currentId]: draft }
    for (const [id, entry] of Object.entries(pending)) {
      const target = byId.get(id)
      if (!target || !entry.text.trim() || !isDirty(entry, target)) continue
      void update(id, {
        text: entry.text.trim(),
        tags: entry.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        weight: entry.weight,
      })
    }
    onOpenChange(false)
  }

  const dirtyCount = Object.entries({ ...drafts, [currentId]: draft }).filter(([id, entry]) => {
    const target = byId.get(id)
    return target != null && isDirty(entry, target)
  }).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Without max-w the Popup takes w-full and fills the whole window — the other
          dialogs of the app define their own width for the same reason. */}
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            {trail.length > 0 && (
              <Hint label={t("memories.back")}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0"

                  onClick={goBack}
                >
                  <ArrowLeft className="size-3.5" />
                </Button>
              </Hint>
            )}
            {t("memories.editTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
          {/* Same metadata as the card, so as not to have to close the dialog
              and go back to the list only to check type, weight or use. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE[current.kind])}>
              {t(`memories.kinds.${current.kind}`, { defaultValue: KIND_LABEL[current.kind] })}
            </Badge>
            {current.category && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {t(`memories.categories.${current.category}`, { defaultValue: CATEGORY_LABEL[current.category] })}
              </Badge>
            )}
            {scopeOf(current) === "both" && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                {t("memories.scopes.both", { defaultValue: "both" })}
              </Badge>
            )}
            {(current.projectName ?? current.originProjectName) && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                {current.projectName ?? current.originProjectName}
              </Badge>
            )}
            {current.area && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                {t(`memories.areas.${current.area}`, { defaultValue: current.area })}
              </Badge>
            )}
            {current.hasDoc && <FileText className="size-3 text-muted-foreground" />}
          </div>

          <div>
            <p className="mb-1 text-xs font-medium">{t("memories.fieldText")}</p>
            <Textarea
              value={draft.text}
              onChange={(e) => setDraft({ text: e.target.value })}
              rows={5}
            />
          </div>

          <div>
            <p className="mb-1 text-xs font-medium">{t("memories.fieldTags")}</p>
            <Input
              value={draft.tags}
              onChange={(e) => setDraft({ tags: e.target.value })}
              placeholder={t("memories.tagsPlaceholder")}
            />
            {draft.tags.trim() && (
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                {draft.tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean)
                  .map((tag, i) => (
                    <span key={`${tag}:${i}`}>#{tag}</span>
                  ))}
              </div>
            )}
          </div>

          <div>
            <p className="mb-1 text-xs font-medium">{t("memories.weight")}</p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft.weight}
                onChange={(e) => setDraft({ weight: Number(e.target.value) })}
                className="flex-1"
                aria-label={t("memories.weight")}
              />
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                {draft.weight.toFixed(2)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t pt-2 text-[11px] text-muted-foreground">
            <span>{t("memories.uses", { count: current.hits })}</span>
            <span>{t("memories.createdAt", { date: formatDate(current.createdAt, i18n.language) })}</span>
            {current.lastHitAt != null && (
              <span>{t("memories.lastUsed", { date: formatDate(current.lastHitAt, i18n.language) })}</span>
            )}
            {current.expiresAt != null && (
              <span>{t("memories.expires", { date: formatDate(current.expiresAt, i18n.language) })}</span>
            )}
          </div>

          {related.length > 0 && (
            <div className="flex flex-col gap-1 border-t pt-2">
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Link2 className="size-3" /> {t("memories.connected")} ({related.length})
              </span>
              <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto pr-1">
                {related.map((r) => {
                  const entry = drafts[r.id]
                  const changed = entry != null && isDirty(entry, r)
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={() => navigateTo(r.id)}
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: KIND_COLOR[r.kind] }}
                      />
                      
                        <Truncate>
                            <span className="truncate">{r.text}</span>
                        </Truncate>
                      {changed && <span className="shrink-0 text-[10px] text-primary">•</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!draft.text.trim() || dirtyCount === 0} onClick={saveAll}>
            {dirtyCount > 1 ? t("memories.saveCount", { count: dirtyCount }) : t("memories.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DocDialog({ memory, open, onOpenChange }: {
  memory: Memory
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const openDoc = useMemoryStore((s) => s.openDoc)
  const [doc, setDoc] = useState<string | null>(null)

  useEffect(() => {
    if (open) void openDoc(memory.id).then(setDoc)
  }, [open, memory.id, openDoc])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: "56rem" }}>
        <DialogHeader>
          <DialogTitle className="pr-6 text-sm font-medium">{memory.text}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] w-full overflow-x-auto pr-3">
          {doc === null ? (
            <p className="text-sm text-muted-foreground">{t("memories.loadingDoc")}</p>
          ) : (
            <div className="w-full break-words">
              <AssistantMarkdown>{doc}</AssistantMarkdown>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function MemoryCardImpl({ memory, related, selected, onSelect, onSelectRelated }: {
  memory: Memory
  /** Memories in relatedIds (backlinks) already resolved by the parent */
  related: Memory[]
  /** Highlight of the card focused in the side panel */
  selected?: boolean
  /**
   * Click on the body of the card — it opens the detail. It receives the id so the parent can
   * pass a stable callback (the memo below depends on that).
   */
  onSelect?: (id: string) => void
  onSelectRelated?: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const remove = useMemoryStore((s) => s.remove)
  const promote = useMemoryStore((s) => s.promote)
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  const { mode, setMode, setView } = useWorkspace()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [docOpen, setDocOpen] = useState(false)

  const originSession = memory.sessionId ? sessions.find((s) => s.id === memory.sessionId) : undefined

  // The most structural first (/init area nodes), then by weight — if
  // only a few fit, let them be the ones that say the most about the node's neighborhood.
  const visibleRelated = useMemo(
    () =>
      [...related]
        .sort((a, b) => (a.area ? 0 : 1) - (b.area ? 0 : 1) || b.weight - a.weight)
        .slice(0, MAX_RELATED_IN_CARD),
    [related],
  )
  const hiddenRelated = related.length - visibleRelated.length

  return (
    <div
      className={cn(
        "group/card flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground transition-colors",
        onSelect && "cursor-pointer hover:border-primary/40",
        selected && "border-primary/70",
      )}
      onClick={(e) => {
        if (!onSelect) return
        // Buttons and fields handle their own click; the dialogs are portals, and
        // in React the event goes up through the component tree, not through the DOM —
        // without this guard, clicking a related one inside the dialog was
        // overwritten by the card's own selection.
        if ((e.target as HTMLElement).closest('button, a, input, textarea, [data-slot="dialog-content"]')) {
          return
        }
        onSelect(memory.id)
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm leading-snug line-clamp-2">{memory.text}</p>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/card:opacity-100">
          {memory.hasDoc && (
            <Hint label={t("memories.viewDoc")}>
              <Button variant="ghost" size="icon" className="size-6"  onClick={() => setDocOpen(true)}>
                <FileText className="size-3.5" />
              </Button>
            </Hint>
          )}
          {originSession && (
            <Hint label={t("memories.openOriginSession", { title: originSession.title })}>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"

                onClick={() => {
                  if (originSession.mode !== mode) setMode(originSession.mode)
                  setView("chat")
                  void selectSession(originSession.mode, originSession.id)
                }}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </Hint>
          )}
          {canPromote(memory) && (
            <Hint label={memory.kind === "seasonal" ? t("memories.promoteCore") : t("memories.promoteDecision")}>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"

                onClick={() => void promote(memory.id)}
              >
                <ArrowUpCircle className="size-3.5" />
              </Button>
            </Hint>
          )}
          <Hint label={t("memories.edit")}>
            <Button variant="ghost" size="icon" className="size-6"  onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </Button>
          </Hint>
          <Hint label={t("memories.delete")}>
            <Button variant="ghost" size="icon" className="size-6"  onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" />
            </Button>
          </Hint>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE[memory.kind])}>
          {t(`memories.kinds.${memory.kind}`, { defaultValue: KIND_LABEL[memory.kind] })}
        </Badge>
        {memory.category && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {t(`memories.categories.${memory.category}`, { defaultValue: CATEGORY_LABEL[memory.category] })}
          </Badge>
        )}
        {scopeOf(memory) === "both" && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
            {t("memories.scopes.both", { defaultValue: "both" })}
          </Badge>
        )}
        {memory.kind === "project" && memory.projectName && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
            {memory.projectName}
          </Badge>
        )}
        {memory.promotedFrom && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
            {t("memories.promoted")}
          </Badge>
        )}
        {memory.hasDoc && <FileText className="size-3 text-muted-foreground" />}
        {memory.tags.map((tag) => (
          <span key={tag} className="text-muted-foreground">#{tag}</span>
        ))}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {t("memories.weightLabel")}
          <span className="inline-block h-1 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary/60"
              style={{ width: `${Math.round(memory.weight * 100)}%` }}
            />
          </span>
        </span>
        <span>{t("memories.uses", { count: memory.hits })}</span>
        <span>{formatDate(memory.createdAt, i18n.language)}</span>
        {memory.expiresAt != null && <span>{t("memories.expires", { date: formatDate(memory.expiresAt, i18n.language) })}</span>}
      </div>

      {related.length > 0 && (
        <div className="flex flex-col gap-1 border-t pt-2">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Link2 className="size-3" /> {t("memories.connected")} ({related.length})
          </span>
          {/* It limits the AMOUNT, not the height: squeezing twelve links into an
              80px scrollable box left the text illegible. The excess opens
              in the editing panel, which lists all of them and navigates between them. */}
          {visibleRelated.map((r) => (
            <button
              key={r.id}
              type="button"
              className="truncate text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => onSelectRelated?.(r.id)}
            >
              • {r.text}
            </button>
          ))}
          {hiddenRelated > 0 && (
            <button
              type="button"
              className="self-start text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setEditing(true)}
            >
              {t("memories.moreConnected", { count: hiddenRelated })}
            </button>
          )}
        </div>
      )}

      {/* Mounted only when open. The EditDialog subscribes to the whole index and
          builds a Map of all the memories; keeping one per card, every selection
          rebuilt that Map hundreds of times and froze the list. */}
      {confirmDelete && (
        <ConfirmDialog
          open
          onOpenChange={setConfirmDelete}
          title={t("memories.deleteTitle")}
          description={memory.hasDoc
            ? t("memories.deleteDescriptionWithDoc", { text: memory.text })
            : t("memories.deleteDescription", { text: memory.text })}
          confirmLabel={t("memories.deleteConfirm")}
          destructive
          onConfirm={() => void remove(memory.id)}
        />
      )}
      {editing && <EditDialog memory={memory} open onOpenChange={setEditing} />}
      {memory.hasDoc && docOpen && <DocDialog memory={memory} open onOpenChange={setDocOpen} />}
    </div>
  )
}

/**
 * Memoized: selecting a memory changed `selectedId` and re-rendered the
 * whole list. It depends on `related` and the callbacks being stable — the view
 * memoizes both.
 */
export const MemoryCard = memo(MemoryCardImpl)
