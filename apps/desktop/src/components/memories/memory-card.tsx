import { useEffect, useMemo, useState } from "react"
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
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useMemoryStore } from "@/src/stores/memory-store"
import { useSessionStore } from "@/src/stores/session-store"
import { CATEGORY_LABEL, KIND_BADGE, KIND_COLOR, KIND_LABEL, canPromote } from "./meta"

/** Quantos vínculos o card mostra antes de remeter ao painel de edição. */
const MAX_RELATED_IN_CARD = 3

function formatDate(ts: number, locale: string) {
  return new Date(ts).toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" })
}

/** Rascunho por memória — preserva edições ao navegar entre nós conectados. */
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
 * Painel de edição. Além dos campos, espelha os metadados do card (tipo,
 * categoria, projeto, peso, usos, datas) e lista os nós conectados — clicar
 * num deles passa a editar aquele nó, sem fechar o diálogo.
 *
 * As edições ficam num rascunho por id, então navegar de um nó para outro e
 * voltar não perde o que foi digitado.
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
  /** Nós visitados a partir do original — alimenta o botão de voltar. */
  const [trail, setTrail] = useState<string[]>([])

  const byId = useMemo(() => new Map(index.map((m) => [m.id, m])), [index])
  const current = byId.get(currentId) ?? memory
  const draft = drafts[currentId] ?? draftOf(current)
  const related = current.relatedIds
    .map((id) => byId.get(id))
    .filter((m): m is Memory => m != null)

  // Reabrir sempre parte da memória do card, com os rascunhos zerados.
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

  /** Grava todos os rascunhos alterados, não só o nó em foco. */
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
      {/* Sem max-w o Popup assume w-full e ocupa a janela inteira — os demais
          diálogos do app definem a própria largura pelo mesmo motivo. */}
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            {trail.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                title={t("memories.back")}
                onClick={goBack}
              >
                <ArrowLeft className="size-3.5" />
              </Button>
            )}
            {t("memories.editTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
          {/* Mesmos metadados do card, para não precisar fechar o diálogo
              e voltar à lista só para conferir tipo, peso ou uso. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE[current.kind])}>
              {t(`memories.kinds.${current.kind}`, { defaultValue: KIND_LABEL[current.kind] })}
            </Badge>
            {current.category && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {t(`memories.categories.${current.category}`, { defaultValue: CATEGORY_LABEL[current.category] })}
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
                      <span className="truncate">{r.text}</span>
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

export function MemoryCard({ memory, related, selected, onSelect, onSelectRelated }: {
  memory: Memory
  /** Memórias em relatedIds (backlinks) já resolvidas pelo pai */
  related: Memory[]
  /** Realce de card em foco no painel lateral */
  selected?: boolean
  /** Clique no corpo do card — abre o detalhe. Sem isto o card não é clicável. */
  onSelect?: () => void
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

  // Os mais estruturais primeiro (nós de área do /init), depois por peso — se
  // só cabem alguns, que sejam os que mais dizem sobre a vizinhança do nó.
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
        // Botões e campos tratam o próprio clique; os diálogos são portais, e
        // no React o evento sobe pela árvore de componentes, não pelo DOM —
        // sem esta guarda, clicar num relacionado dentro do diálogo era
        // sobrescrito pela seleção do próprio card.
        if ((e.target as HTMLElement).closest('button, a, input, textarea, [data-slot="dialog-content"]')) {
          return
        }
        onSelect()
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm leading-snug line-clamp-2">{memory.text}</p>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/card:opacity-100">
          {memory.hasDoc && (
            <Button variant="ghost" size="icon" className="size-6" title={t("memories.viewDoc")} onClick={() => setDocOpen(true)}>
              <FileText className="size-3.5" />
            </Button>
          )}
          {originSession && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              title={t("memories.openOriginSession", { title: originSession.title })}
              onClick={() => {
                if (originSession.mode !== mode) setMode(originSession.mode)
                setView("chat")
                void selectSession(originSession.mode, originSession.id)
              }}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          )}
          {canPromote(memory) && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              title={memory.kind === "seasonal" ? t("memories.promoteCore") : t("memories.promoteDecision")}
              onClick={() => void promote(memory.id)}
            >
              <ArrowUpCircle className="size-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-6" title={t("memories.edit")} onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" title={t("memories.delete")} onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-3.5" />
          </Button>
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
          {/* Limita a QUANTIDADE, não a altura: espremer doze vínculos numa
              caixa rolável de 80px deixava o texto ilegível. O excedente abre
              no painel de edição, que lista todos e navega entre eles. */}
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

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("memories.deleteTitle")}
        description={memory.hasDoc
          ? t("memories.deleteDescriptionWithDoc", { text: memory.text })
          : t("memories.deleteDescription", { text: memory.text })}
        confirmLabel={t("memories.deleteConfirm")}
        destructive
        onConfirm={() => void remove(memory.id)}
      />
      <EditDialog memory={memory} open={editing} onOpenChange={setEditing} />
      {memory.hasDoc && <DocDialog memory={memory} open={docOpen} onOpenChange={setDocOpen} />}
    </div>
  )
}
