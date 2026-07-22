"use client"

import { useState } from "react"
import { CheckIcon, ChevronDown, LoaderIcon, MessageSquareIcon, TerminalIcon, XCircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface TaskItem {
  id: string
  title: string
  status: "idle" | "submitted" | "streaming" | "error"
  mode?: "chat" | "code"
}

export function TaskProgress({
  tasks,
  title = "Tarefas",
  defaultExpanded = true,
}: {
  tasks: TaskItem[]
  title?: string
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const total = tasks.length
  const done = tasks.filter((t) => t.status === "idle")
    .length
  const running = tasks.some(
    (t) => t.status === "submitted" || t.status === "streaming",
  )
  const progress = total > 0 ? Math.round((done / total) * 100) : 0

  if (total === 0) return null

  return (
    <div className="rounded-xl border border-sidebar-border bg-sidebar/50 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-sidebar-accent/30 transition-colors"
      >
        <ChevronDown className={cn("size-3 shrink-0 transition-transform text-muted-foreground", !expanded && "-rotate-90")} />
        {running ? (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
        )}
        <span className="font-medium text-foreground">
          {running ? `${title} em andamento` : `${title} concluídas`}
        </span>
        <span className="text-muted-foreground">
          {done}/{total}
        </span>
        <div className="ml-auto h-1.5 min-w-16 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-sidebar-border px-1 pb-1.5 pt-1">
          {tasks.map((task) => {
            const isDone = task.status === "idle"
            return (
              <div
                key={task.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1",
                  isDone && "opacity-60",
                )}
              >
                <TaskIcon status={task.status} />
                {task.mode === "code" ? (
                  <TerminalIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : task.mode === "chat" ? (
                  <MessageSquareIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    isDone && "line-through text-muted-foreground",
                  )}
                  title={task.title}
                >
                  {task.title}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TaskIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    case "submitted":
    case "streaming":
      return <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />
    case "error":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
    case "idle":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
    default:
      return <div className="size-3.5 shrink-0 rounded-full border border-muted-foreground/30" />
  }
}
