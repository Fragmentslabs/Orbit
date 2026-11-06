import { memo } from "react"
import { useTranslation } from "react-i18next"
import { FileText } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Memory } from "@shared/memory"
import { KIND_COLOR } from "./meta"

/**
 * Compact card of the memories list: the kind color on the left, the title on top, the
 * tags below and the number of uses in the corner. Everything else (weight, dates,
 * connections, editing) lives in the detail tab of the side panel — one click away.
 */
function MemoryListItemImpl({ memory, selected, onOpen }: {
  memory: Memory
  /** Memory whose tab is the active one in the side panel. */
  selected: boolean
  /** Receives the id so the parent can pass a stable callback (the memo depends on it). */
  onOpen: (id: string) => void
}) {
  const { t } = useTranslation()
  const title = memory.title?.trim() || memory.text

  return (
    <button
      type="button"
      onClick={() => onOpen(memory.id)}
      className={cn(
        "flex w-full items-stretch gap-3 rounded-lg border bg-card p-3 text-left text-card-foreground transition-colors hover:border-primary/40",
        selected && "border-primary/70",
      )}
    >
      <span
        className="w-1 shrink-0 rounded-full"
        style={{ backgroundColor: KIND_COLOR[memory.kind] }}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="line-clamp-2 text-sm font-medium leading-snug">{title}</span>
        {memory.tags.length > 0 ? (
          <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {memory.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </span>
        ) : memory.title?.trim() ? (
          // Without tags, the text fills the space that would be empty.
          <span className="line-clamp-1 text-xs text-muted-foreground">{memory.text}</span>
        ) : null}
      </span>
      <span
        className="flex shrink-0 items-start gap-1.5 text-[11px] tabular-nums text-muted-foreground"
        title={t("memories.uses", { count: memory.hits })}
      >
        {memory.hasDoc && <FileText className="mt-px size-3" aria-hidden />}
        {memory.hits}
      </span>
    </button>
  )
}

/**
 * Memoized: opening a tab changes the highlighted card and used to re-render the
 * whole list. It depends on `onOpen` being stable — the view memoizes it.
 */
export const MemoryListItem = memo(MemoryListItemImpl)
