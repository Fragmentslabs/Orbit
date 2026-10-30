import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FileText, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { Memory } from "@shared/memory"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useMemoryStore } from "@/src/stores/memory-store"
import { MemoryCard } from "./memory-card"
import { Hint } from "@/components/ui/hint"

/**
 * Side panel of the selected memory — shared by the List and
 * Graph tabs, so that clicking a card and clicking a node lead to the same place.
 *
 * The card stays fixed at the top and the content takes the rest of the height: the attached
 * markdown document when it exists, otherwise the full text of the memory (the card
 * cuts it into two lines, so here is where it appears whole).
 */
export function MemoryDetailPanel({ memory, related, onSelectRelated, onClose, className }: {
  memory: Memory
  related: Memory[]
  onSelectRelated: (id: string) => void
  /** Close the view. Absent = there is nothing to close (panel tab: the tab has its own X). */
  onClose?: () => void
  /** Width/occupancy — the panel tab uses the whole width instead of the fixed w-96. */
  className?: string
}) {
  const { t } = useTranslation()
  const openDoc = useMemoryStore((s) => s.openDoc)
  const [doc, setDoc] = useState<string | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)

  useEffect(() => {
    if (!memory.hasDoc) {
      setDoc(null)
      return
    }
    let active = true
    setLoadingDoc(true)
    void openDoc(memory.id).then((content) => {
      // The memory may have changed while the doc was loading — without this guard,
      // a delayed response would overwrite the content of the current memory.
      if (!active) return
      setDoc(content)
      setLoadingDoc(false)
    })
    return () => {
      active = false
    }
  }, [memory.id, memory.hasDoc, openDoc])

  return (
    <aside className={cn("flex shrink-0 flex-col gap-2 overflow-hidden", className ?? "w-96")}>
      {/* The close stays on its own row: next to the card it stole width and
          left the card narrower than the document box below. */}
      {onClose && (
        <div className="flex justify-end">
          <Hint label={t("common.close")}>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"

              onClick={onClose}
            >
              <X className="size-3.5" />
            </Button>
          </Hint>
        </div>
      )}
      <MemoryCard memory={memory} related={related} onSelectRelated={onSelectRelated} />

      <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
        <div className="flex items-center gap-1.5 border-b px-3 py-2 text-[11px] font-medium text-muted-foreground">
          <FileText className="size-3" />
          {memory.hasDoc ? t("memories.attachedDoc") : t("memories.fullText")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {memory.hasDoc && loadingDoc ? (
            // The doc comes from the disk over IPC: a skeleton instead of a waiting text,
            // so the panel does not blink between two different layouts.
            <div className="flex flex-col gap-2" aria-label={t("memories.loadingDoc")}>
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="mt-2 h-4 w-1/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          ) : doc ? (
            <div className="w-full break-words text-xs">
              <AssistantMarkdown>{doc}</AssistantMarkdown>
            </div>
          ) : (
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">
              {memory.text}
            </p>
          )}
        </div>
      </div>
    </aside>
  )
}
