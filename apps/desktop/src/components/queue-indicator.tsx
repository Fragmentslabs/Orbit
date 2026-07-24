import { useState } from "react"
import { CalendarIcon, ChevronDownIcon, ListPlus } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { cn } from "@/lib/utils"

interface QueueIndicatorProps {
  sessionId?: string
}

function formatSchedule(ts: number): string {
  const now = Date.now()
  const diff = ts - now
  if (diff < 0) return "Agora"
  if (diff < 60_000) return "Em segundos"
  if (diff < 3_600_000) return `Em ${Math.ceil(diff / 60_000)}min`
  if (diff < 86_400_000) return `Em ${Math.ceil(diff / 3_600_000)}h`
  return new Date(ts).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  })
}

export function QueueIndicator({ sessionId }: QueueIndicatorProps) {
  const [open, setOpen] = useState(false)
  const queues = useMessageQueueStore((s) => s.queues)
  if (!sessionId) return null
  const items = queues[sessionId]
  if (!items || items.length === 0) return null

  const queueCount = items.filter((m) => !m.scheduledAt).length
  const scheduledCount = items.filter((m) => m.scheduledAt).length

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted mb-1">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {queueCount > 0 && <ListPlus className="size-3.5" />}
          {scheduledCount > 0 && <CalendarIcon className="size-3.5" />}
          <span>
            {items.length} {items.length === 1 ? "mensagem" : "mensagens"} na fila
          </span>
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
          {items.map((msg) => (
            <div
              key={msg.id}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs hover:bg-muted/50"
            >
              {msg.scheduledAt ? (
                <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ListPlus className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="line-clamp-1 flex-1 text-muted-foreground">
                {msg.text}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/60">
                {msg.scheduledAt ? formatSchedule(msg.scheduledAt) : "Fila"}
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
