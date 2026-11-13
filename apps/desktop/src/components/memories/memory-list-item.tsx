import { memo } from "react"
import { useTranslation } from "react-i18next"
import { FileText } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Memory } from "@shared/memory"
import { KIND_BADGE, KIND_LABEL, KIND_PILL } from "./meta"
import { KIND_ICON } from "./memory-kind-icon"

/**
 * Compact card of the memories list: the kind as an icon on the left and as a badge on the
 * right, the tags below the title and the number of uses in the corner. Everything else
 * (weight, dates, connections, editing) lives in the detail tab of the side panel — one
 * click away.
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
  const Icon = KIND_ICON[memory.kind]

  return (
    <button
      type="button"
      onClick={() => onOpen(memory.id)}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg border bg-card p-3 text-left text-card-foreground transition-colors hover:border-primary/40",
        selected && "border-primary/70",
      )}
    >
      {/* O tipo pelo ícone, na cor que ele tem na árvore — o mesmo desenho do filtro. */}
      <span
        className={cn("grid size-[26px] shrink-0 place-items-center rounded-lg", KIND_BADGE[memory.kind])}
        aria-hidden
      >
        <Icon className="size-3.5" />
      </span>
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
      {/* Selo do tipo em cima e usos embaixo — a coluna da direita, como na lista de rotinas. */}
      <span className="flex shrink-0 flex-col items-end justify-between gap-2 self-stretch">
        <span
          className={cn(
            "inline-flex min-w-[62px] items-center justify-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] capitalize leading-none",
            KIND_PILL[memory.kind],
          )}
        >
          <span className="size-1 shrink-0 rounded-full bg-current" aria-hidden />
          {t(`memories.kinds.${memory.kind}`, { defaultValue: KIND_LABEL[memory.kind] })}
        </span>
        <span
          className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
          title={t("memories.uses", { count: memory.hits })}
        >
          {memory.hasDoc && <FileText className="size-3" aria-hidden />}
          {memory.hits}
        </span>
      </span>
    </button>
  )
}

/**
 * Memoized: opening a tab changes the highlighted card and used to re-render the
 * whole list. It depends on `onOpen` being stable — the view memoizes it.
 */
export const MemoryListItem = memo(MemoryListItemImpl)
