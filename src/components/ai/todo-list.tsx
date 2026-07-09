import { Check, Circle, LoaderCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ToolPart } from "@/shared/chat"

/**
 * Checklist viva da tool todowrite. A última chamada da mensagem é a lista
 * atual; chamadas anteriores (stale) viram uma linha discreta.
 */

interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "low" | "medium" | "high"
}

function itemsOf(part: ToolPart): TodoItem[] {
  const items = part.input?.items
  return Array.isArray(items) ? (items as TodoItem[]) : []
}

function StatusIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") return <Check className="size-3.5 text-emerald-500" />
  if (status === "in_progress")
    return <LoaderCircle className="size-3.5 animate-spin text-primary" />
  return <Circle className="size-3.5 text-muted-foreground/50" />
}

export function TodoList({ part, stale }: { part: ToolPart; stale?: boolean }) {
  const items = itemsOf(part)
  if (items.length === 0) return null
  const done = items.filter((i) => i.status === "completed").length

  if (stale) {
    return (
      <p className="not-prose my-1 text-xs text-muted-foreground">
        TODO ({done}/{items.length} concluídos) — atualizada mais abaixo
      </p>
    )
  }

  return (
    <div className="not-prose my-2 flex w-full flex-col gap-1 rounded-lg border bg-card/50 p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Tarefas ({done}/{items.length})
      </p>
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <span className="mt-0.5 shrink-0">
            <StatusIcon status={item.status} />
          </span>
          <span
            className={cn(
              "min-w-0 flex-1",
              item.status === "completed" && "text-muted-foreground line-through",
              item.status === "in_progress" && "text-foreground",
              item.status === "pending" && "text-muted-foreground",
            )}
          >
            {item.content}
            {item.priority === "high" && item.status !== "completed" && (
              <span className="ml-1.5 text-[10px] font-medium text-amber-500">alta</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
