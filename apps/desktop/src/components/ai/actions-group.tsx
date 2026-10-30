import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ToolPart } from "@shared/chat"
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "@/src/components/ai/task"
import { Shimmer } from "@/src/components/ai/shimmer"
import { computerActionSummary, describeAction, isComputerTool } from "@/src/lib/computer-actions"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * The tools of a turn, collapsed into a single line.
 *
 * Code mode always did this: while it works, the list stays open and one
 * follows what is happening; when the answer arrives, everything folds into
 * "27 actions performed" and what remains in the conversation is the ANSWER. In chat each
 * call became a card that stayed there forever, and re-reading the conversation meant
 * scrolling over the staircase that led to it.
 *
 * This here is the common piece of both. Code mode has its own group
 * on top of this one (with the diff and the test summary, which only exist there); chat
 * uses this one directly.
 */

/** How many tools appear without asking for "show all". */
const MAX_VISIBLE = 6

function useActionLabels(): Record<string, string> {
  const { t } = useTranslation()
  return {
    read: t("chat.actions.read"),
    write: t("chat.actions.write"),
    edit: t("chat.actions.edit"),
    ls: t("chat.actions.ls"),
    glob: t("chat.actions.glob"),
    grep: t("chat.actions.grep"),
    code_search: t("chat.actions.code_search"),
    code_outline: t("chat.actions.code_outline"),
    code_refs: t("chat.actions.code_refs"),
    bash: t("chat.actions.bash"),
    websearch: t("chat.actions.websearch"),
    webfetch: t("chat.actions.webfetch"),
    set_user_name: t("chat.actions.set_user_name"),
  }
}

/** The argument that identifies the call: path, query, url, command. */
export function toolChip(part: ToolPart): string | undefined {
  const input = part.input ?? {}
  const candidate =
    input.filePath ?? input.dirPath ?? input.pattern ?? input.query ?? input.symbol ?? input.url ?? input.command
  if (typeof candidate !== "string" || !candidate) return undefined
  const isPath = typeof input.filePath === "string" || typeof input.dirPath === "string"
  return isPath ? candidate.split(/[\\/]/).pop() : candidate
}

/** Full output in the expanded detail — the ceiling avoids pasting an app's whole tree into the chat. */
const MAX_DETAIL = 4000

export function ToolActionItem({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const [showOutput, setShowOutput] = useState(false)
  const actionLabels = useActionLabels()
  // Computer Use: the sentence of what the agent did ("Click element 12 ·
  // TextEdit") and, below it, what happened — instead of a raw "cu_computer".
  const computer = isComputerTool(part.tool)
  const label = computer ? describeAction(part, t) : actionLabels[part.tool] ?? part.tool
  const chip = computer ? undefined : toolChip(part)
  const summary = computer ? computerActionSummary(part) : null
  const fullOutput = part.error ?? (part.tool === "bash" || computer ? part.output : undefined)
  const detail = fullOutput && fullOutput.length > MAX_DETAIL ? `${fullOutput.slice(0, MAX_DETAIL)}…` : fullOutput

  return (
    <TaskItem>
      <button
        type="button"
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 text-left",
          detail && "cursor-pointer hover:text-foreground",
          part.state === "error" && "text-destructive",
        )}
        onClick={() => detail && setShowOutput((v) => !v)}
      >
        {part.state === "running" ? <Shimmer>{label}</Shimmer> : <span>{label}</span>}
        {chip && (
          <TaskItemFile>
            {/* title = full command/path on hover (truncate cuts at ~256px) */}
            
              <Truncate>
                  <span className="max-w-64 truncate font-mono" title={chip}>
                  {chip}
                </span>
              </Truncate>
          </TaskItemFile>
        )}
        {detail && (
          <ChevronDownIcon
            className={cn("size-3 shrink-0 transition-transform", showOutput && "rotate-180")}
          />
        )}
      </button>
      {summary && !showOutput && (
        <p className={cn("mt-0.5 line-clamp-2 text-[11px] text-muted-foreground", part.state === "error" && "text-destructive/80")}>{summary}</p>
      )}
      {showOutput && detail && (
        <pre className="mt-1 max-h-56 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </TaskItem>
  )
}

/**
 * Opens by itself while it works and closes by itself one second after
 * finishing. The delay is on purpose: closing at the very instant the last
 * result appears is the difference between "I followed it" and "it blinked".
 */
export function ActionsGroup({
  parts,
  className,
  flat,
}: {
  parts: ToolPart[]
  className?: string
  /** Detailed mode: every action listed, no accordion and no "show more". */
  flat?: boolean
}) {
  const { t } = useTranslation()
  const working = parts.some((p) => p.state === "running")
  const errors = parts.filter((p) => p.state === "error").length
  const [open, setOpen] = useState(working)
  const [showAll, setShowAll] = useState(false)
  const prevWorking = useRef(working)

  useEffect(() => {
    if (working) setOpen(true)
  }, [working])

  useEffect(() => {
    if (prevWorking.current && !working) {
      const timer = setTimeout(() => setOpen(false), 1000)
      return () => clearTimeout(timer)
    }
    prevWorking.current = working
  }, [working])

  useEffect(() => {
    setShowAll(false)
  }, [parts.length])

  const visibleParts = showAll ? parts : parts.slice(-MAX_VISIBLE)
  const hiddenCount = parts.length - visibleParts.length

  const title = working
    ? t("chat.code.working")
    : errors > 0
      ? t("chat.code.actionsWithError", { count: parts.length, errors })
      : t("chat.code.actionsDone", { count: parts.length })

  if (flat) {
    return (
      <div className={cn("not-prose my-2 flex w-full flex-col gap-1", className)}>
        {parts.map((part) => (
          <ToolActionItem key={part.id} part={part} />
        ))}
      </div>
    )
  }

  return (
    <Task open={open} onOpenChange={setOpen} className={cn("not-prose my-2 w-full", className)}>
      <TaskTrigger title={title}>
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          {working ? <Shimmer>{title}</Shimmer> : <p className="text-sm">{title}</p>}
          <ChevronDownIcon
            className={cn("ml-auto size-4 transition-transform", open ? "rotate-0" : "-rotate-90")}
          />
        </div>
      </TaskTrigger>
      <TaskContent>
        {visibleParts.map((part) => (
          <ToolActionItem key={part.id} part={part} />
        ))}
        {hiddenCount > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("chat.code.hiddenActions", { count: hiddenCount })}
          </button>
        )}
      </TaskContent>
    </Task>
  )
}
