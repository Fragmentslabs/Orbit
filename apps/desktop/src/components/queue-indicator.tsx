import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { ArrowUpToLine, CalendarIcon, CheckIcon, ChevronDownIcon, CopyIcon, ListPlus, PencilIcon, SendIcon, X } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible"
import { Hint } from "@/components/ui/hint"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useSessionStore } from "@/src/stores/session-store"
import type { QueuedMessage } from "@shared/chat"
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

/** The queue of this computer's chat. */
export function QueueIndicator({ sessionId }: QueueIndicatorProps) {
  const queues = useMessageQueueStore((s) => s.queues)
  const editing = useMessageQueueStore((s) => s.editing)
  const remove = useMessageQueueStore((s) => s.remove)
  const moveToFront = useMessageQueueStore((s) => s.moveToFront)
  const sendNow = useMessageQueueStore((s) => s.sendNow)
  const startEdit = useMessageQueueStore((s) => s.startEdit)
  const cancelEdit = useMessageQueueStore((s) => s.cancelEdit)
  // The previous turn failed: the queue does not go on by itself (see processQueue) — without
  // warning, it would look stuck.
  const paused = useSessionStore((s) => (sessionId ? s.status[sessionId] === "error" : false))
  if (!sessionId) return null
  return (
    <QueueView
      items={queues[sessionId]}
      editingId={editing[sessionId]}
      paused={paused}
      onRemove={(id) => remove(sessionId, id)}
      onMoveToFront={(id) => moveToFront(sessionId, id)}
      onSendNow={(id) => sendNow(sessionId, id)}
      onStartEdit={(id) => startEdit(sessionId, id)}
      onCancelEdit={() => cancelEdit(sessionId)}
    />
  )
}

/**
 * The queue list itself. The chat of another desktop feeds it from that machine's queue;
 * an action left out (`onStartEdit`, `onSendNow`) is simply not drawn.
 */
export function QueueView({ items, editingId, paused, onRemove, onMoveToFront, onSendNow, onStartEdit, onCancelEdit }: {
  items: QueuedMessage[] | undefined
  editingId?: string
  paused: boolean
  onRemove: (id: string) => void
  onMoveToFront: (id: string) => void
  onSendNow?: (id: string) => void
  onStartEdit?: (id: string) => void
  onCancelEdit?: () => void
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  // Id of the last copied item — it swaps the icon for a check for an instant.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  if (!items || items.length === 0) return null

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
                  {/* A message with only an attachment has no text: the file name is
                      what identifies the item in the queue. */}
                  {msg.text || msg.files?.[0]?.filename || t("queue.attachmentOnly")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="text-[10px] text-muted-foreground/60">
                  {msg.scheduledAt ? formatSchedule(msg.scheduledAt, i18n.language, t) : t("queue.badge")}
                </span>
                {/* The first of the queue is the next to leave: the button would have
                    nothing to do on it. */}
                {index > 0 && (
                  <Hint label={t("queue.sendFirst")}>
                    <button
                      type="button"
                      onClick={() => onMoveToFront(msg.id)}
                      className="cursor-pointer rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <ArrowUpToLine className="size-3.5" />
                    </button>
                  </Hint>
                )}
                {paused && onSendNow && (
                  <Hint label={t("queue.sendNow")}>
                    <button
                      type="button"
                      onClick={() => onSendNow?.(msg.id)}

                      className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <SendIcon className="size-3.5" />
                    </button>
                  </Hint>
                )}
                {onStartEdit && (
                <Hint label={editingId === msg.id ? t("queue.cancelEdit") : t("queue.edit")}>
                  <button
                    type="button"
                    onClick={() => {
                      // It was THIS item that was being edited: the pencil cancels (the
                      // input text stays where it is — we never erase what the
                      // person wrote).
                      if (editingId === msg.id) {
                        onCancelEdit?.()
                        return
                      }
                      // The text of the item goes to the main input; Enter saves
                      // back here, without changing the queue order.
                      onStartEdit?.(msg.id)
                    }}

                    className={cn(
                      "rounded p-0.5 transition-colors hover:bg-accent hover:text-accent-foreground",
                      editingId === msg.id ? "text-primary" : "text-muted-foreground/50",
                    )}
                  >
                    <PencilIcon className="size-3.5" />
                  </button>
                </Hint>
                )}
                <Hint label={t("queue.copy")}>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(msg.text)
                      setCopiedId(msg.id)
                      setTimeout(() => setCopiedId((current) => (current === msg.id ? null : current)), 1500)
                    }}
                    className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
       
                           {copiedId === msg.id ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                </button>
                </Hint>
                <Hint label={t("queue.cancelSend")}>
                  <button
                    type="button"
                    onClick={() => onRemove(msg.id)}

                    className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </Hint>
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
      {/* Edit mode notice: it stays outside the collapsible content, so it remains
          visible with the list closed — without it Enter would save into the queue without the
          person noticing. */}
      {editingId && (
        <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1 text-xs text-primary">
          <PencilIcon className="size-3" />
          {t("queue.editing")}
          <Hint label={t("queue.cancelEdit")}>
            <button
              type="button"
              onClick={() => onCancelEdit?.()}

              className="ml-auto rounded-sm p-0.5 transition-colors hover:bg-primary/20"
            >
              <X className="size-3" />
            </button>
          </Hint>
        </div>
      )}
    </Collapsible>
  )
}
