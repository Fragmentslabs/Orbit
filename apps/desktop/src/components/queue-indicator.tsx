import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { ArrowUpToLine, CalendarIcon, CheckIcon, ChevronDownIcon, CopyIcon, ListPlus, PencilIcon, SendIcon, X } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useSessionStore } from "@/src/stores/session-store"
import { cn } from "@/lib/utils"
import { formatTime } from "@/src/lib/format"

interface QueueIndicatorProps {
  sessionId?: string
}

function formatSchedule(ts: number, locale: string, t: TFunction): string {
  const diff = ts - Date.now()
  if (diff < 0) return t("queue.now")
  if (diff < 60_000) return t("queue.inSeconds")
  if (diff < 3_600_000) return t("queue.inMinutes", { count: Math.ceil(diff / 60_000) })
  if (diff < 86_400_000) return t("queue.inHours", { count: Math.ceil(diff / 3_600_000) })
  const date = new Date(ts).toLocaleDateString(locale, { dateStyle: "short" })
  return `${date} ${formatTime(ts, locale)}`
}

export function QueueIndicator({ sessionId }: QueueIndicatorProps) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  // Id do item copiado por último — troca o ícone pra check por um instante.
  // Um só vale porque copiar é instantâneo; não precisa ser um Set.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const queues = useMessageQueueStore((s) => s.queues)
  const editing = useMessageQueueStore((s) => s.editing)
  const remove = useMessageQueueStore((s) => s.remove)
  const moveToFront = useMessageQueueStore((s) => s.moveToFront)
  const sendNow = useMessageQueueStore((s) => s.sendNow)
  const startEdit = useMessageQueueStore((s) => s.startEdit)
  const cancelEdit = useMessageQueueStore((s) => s.cancelEdit)
  // Turno anterior falhou: a fila não sai sozinha (ver processQueue) — sem
  // avisar, pareceria travada.
  const paused = useSessionStore((s) => (sessionId ? s.status[sessionId] === "error" : false))
  if (!sessionId) return null
  const items = queues[sessionId]
  if (!items || items.length === 0) return null
  const editingId = editing[sessionId]

  const queueCount = items.filter((m) => !m.scheduledAt).length
  const scheduledCount = items.filter((m) => m.scheduledAt).length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted mb-1">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {queueCount > 0 && <ListPlus className="size-3.5" />}
          {scheduledCount > 0 && <CalendarIcon className="size-3.5" />}
          <span>{t("queue.count", { count: items.length })}</span>
          {paused && <span className="text-destructive/80">· {t("queue.paused")}</span>}
        </span>
        <ChevronDownIcon
          className={cn(
            "ml-auto size-3.5 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-1 flex flex-col gap-0.5">
          {items.map((msg, index) => (
            <div
              key={msg.id}
              title={msg.text}
              className={cn(
                "group/item flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs hover:bg-muted/50",
                editingId === msg.id && "bg-primary/10 ring-1 ring-primary/40",
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {msg.scheduledAt ? (
                  <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ListPlus className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="line-clamp-1 text-muted-foreground">
                  {msg.text}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="text-[10px] text-muted-foreground/60">
                  {msg.scheduledAt ? formatSchedule(msg.scheduledAt, i18n.language, t) : t("queue.badge")}
                </span>
                {/* O primeiro da fila é o próximo a sair: o botão não teria o
                    que fazer nele. */}
                {index > 0 && (
                  <button
                    type="button"
                    onClick={() => moveToFront(sessionId, msg.id)}
                    title={t("queue.sendFirst")}
                    className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <ArrowUpToLine className="size-3.5" />
                  </button>
                )}
                {paused && (
                  <button
                    type="button"
                    onClick={() => sendNow(sessionId, msg.id)}
                    title={t("queue.sendNow")}
                    className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <SendIcon className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    // Era ESTE item que estava em edição: o lápis cancela (o
                    // texto do input fica onde está — nunca apagamos o que a
                    // pessoa escreveu).
                    if (editingId === msg.id) {
                      cancelEdit(sessionId)
                      return
                    }
                    // O texto do item vai para o input principal; o Enter grava
                    // de volta aqui, sem mudar a ordem da fila.
                    startEdit(sessionId, msg.id)
                  }}
                  title={editingId === msg.id ? t("queue.cancelEdit") : t("queue.edit")}
                  className={cn(
                    "rounded p-0.5 transition-colors hover:bg-accent hover:text-accent-foreground",
                    editingId === msg.id ? "text-primary" : "text-muted-foreground/50",
                  )}
                >
                  <PencilIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(msg.text)
                    setCopiedId(msg.id)
                    setTimeout(() => setCopiedId((current) => (current === msg.id ? null : current)), 1500)
                  }}
                  title={t("queue.copy")}
                  className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {copiedId === msg.id ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => remove(sessionId, msg.id)}
                  title={t("queue.cancelSend")}
                  className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
      {/* Aviso do modo edição: fica fora do conteúdo recolhível, então continua
          visível com a lista fechada — sem ele o Enter gravaria na fila sem a
          pessoa perceber. */}
      {editingId && (
        <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1 text-xs text-primary">
          <PencilIcon className="size-3" />
          {t("queue.editing")}
          <button
            type="button"
            onClick={() => cancelEdit(sessionId)}
            title={t("queue.cancelEdit")}
            className="ml-auto rounded-sm p-0.5 transition-colors hover:bg-primary/20"
          >
            <X className="size-3" />
          </button>
        </div>
      )}
    </Collapsible>
  )
}
