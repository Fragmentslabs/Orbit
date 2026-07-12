import { useEffect, useState } from "react"
import { ArrowUpCircle, ExternalLink, FileText, Link2, Pencil, Trash2 } from "lucide-react"
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
import type { Memory } from "@/shared/memory"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useMemoryStore } from "@/src/stores/memory-store"
import { useSessionStore } from "@/src/stores/session-store"
import { CATEGORY_LABEL, KIND_BADGE, KIND_LABEL, canPromote } from "./meta"

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" })
}

function EditDialog({ memory, open, onOpenChange }: {
  memory: Memory
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const update = useMemoryStore((s) => s.update)
  const [text, setText] = useState(memory.text)
  const [tags, setTags] = useState(memory.tags.join(", "))
  const [weight, setWeight] = useState(memory.weight)

  useEffect(() => {
    if (open) {
      setText(memory.text)
      setTags(memory.tags.join(", "))
      setWeight(memory.weight)
    }
  }, [open, memory])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar memória</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags separadas por vírgula"
          />
          <label className="flex items-center gap-3 text-xs text-muted-foreground">
            Peso
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={weight}
              onChange={(e) => setWeight(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-8 text-right tabular-nums">{weight.toFixed(2)}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            disabled={!text.trim()}
            onClick={() => {
              void update(memory.id, {
                text: text.trim(),
                tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
                weight,
              })
              onOpenChange(false)
            }}
          >
            Salvar
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
            <p className="text-sm text-muted-foreground">Carregando documento…</p>
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

export function MemoryCard({ memory, related, onSelectRelated }: {
  memory: Memory
  /** Memórias em relatedIds (backlinks) já resolvidas pelo pai */
  related: Memory[]
  onSelectRelated?: (id: string) => void
}) {
  const remove = useMemoryStore((s) => s.remove)
  const promote = useMemoryStore((s) => s.promote)
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  const { mode, setMode, setView } = useWorkspace()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [docOpen, setDocOpen] = useState(false)

  const originSession = memory.sessionId ? sessions.find((s) => s.id === memory.sessionId) : undefined

  return (
    <div className="group/card flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm leading-snug">{memory.text}</p>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/card:opacity-100">
          {memory.hasDoc && (
            <Button variant="ghost" size="icon" className="size-6" title="Ver documento anexado" onClick={() => setDocOpen(true)}>
              <FileText className="size-3.5" />
            </Button>
          )}
          {originSession && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              title={`Abrir conversa de origem: ${originSession.title}`}
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
              title={memory.kind === "seasonal" ? "Promover a core (permanente)" : "Promover a decisão (permanente)"}
              onClick={() => void promote(memory.id)}
            >
              <ArrowUpCircle className="size-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-6" title="Editar" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" title="Deletar" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE[memory.kind])}>
          {KIND_LABEL[memory.kind]}
        </Badge>
        {memory.kind === "project" && memory.category && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {CATEGORY_LABEL[memory.category]}
          </Badge>
        )}
        {memory.kind === "project" && memory.projectName && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
            {memory.projectName}
          </Badge>
        )}
        {memory.promotedFrom && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
            promovida
          </Badge>
        )}
        {memory.hasDoc && <FileText className="size-3 text-muted-foreground" />}
        {memory.tags.map((tag) => (
          <span key={tag} className="text-muted-foreground">#{tag}</span>
        ))}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          peso
          <span className="inline-block h-1 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary/60"
              style={{ width: `${Math.round(memory.weight * 100)}%` }}
            />
          </span>
        </span>
        <span>{memory.hits} uso{memory.hits === 1 ? "" : "s"}</span>
        <span>{formatDate(memory.createdAt)}</span>
        {memory.expiresAt != null && <span>expira {formatDate(memory.expiresAt)}</span>}
      </div>

      {related.length > 0 && (
        <div className="flex flex-col gap-1 border-t pt-2">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Link2 className="size-3" /> Conectadas
          </span>
          {related.map((r) => (
            <button
              key={r.id}
              type="button"
              className="truncate text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => onSelectRelated?.(r.id)}
            >
              • {r.text}
            </button>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Excluir memória?"
        description={`"${memory.text}" será excluída permanentemente${memory.hasDoc ? ", junto com o documento anexado" : ""}.`}
        confirmLabel="Excluir"
        destructive
        onConfirm={() => void remove(memory.id)}
      />
      <EditDialog memory={memory} open={editing} onOpenChange={setEditing} />
      {memory.hasDoc && <DocDialog memory={memory} open={docOpen} onOpenChange={setDocOpen} />}
    </div>
  )
}
