import { Fragment, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { BrainIcon, FileTextIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { splitMemoryIds } from "@/src/lib/citations"
import { CATEGORY_LABEL, KIND_BADGE, KIND_LABEL } from "@/src/components/memories/meta"
import { useMemoryById } from "@/src/hooks/use-memory"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"

/** Label short enough to fit in the middle of a sentence. */
function shortLabel(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean
}

/**
 * Memory citation in the conversation: `[user language](#orbit-memory/mem_xxx)`.
 *
 * A chip in the middle of the sentence (same language as the document citation), a hover card
 * with the summary, a click opens the memory in the side panel — the conversation stays
 * visible alongside. The raw id never appears as text: when the model writes
 * a loose `mem_xxx`, linkifyMemoryIds converts it into the same chip.
 *
 * The memory is resolved through the store index; an id that does not exist (deleted
 * memory, or a link invented by the model) does not become a dead click: the chip
 * appears dimmed and the card says it did not find it.
 */
export function MemoryCitation({ memoryId, label, sessionId }: {
  memoryId: string
  label: string
  sessionId?: string
}) {
  const { t } = useTranslation()
  const memory = useMemoryById(memoryId)
  const openMemoryTab = usePanelStore((s) => s.openMemoryTab)

  // The link text rules (it was written for that sentence); when it is only the
  // id — the linkify case — the memory title counts.
  const bareId = label.trim() === memoryId
  const title = bareId
    ? memory?.title?.trim() || (memory ? shortLabel(memory.text) : memoryId)
    : shortLabel(label)

  const open = () => {
    openMemoryTab(sessionId ?? ORPHAN_KEY, { memoryId, title: memory?.title?.trim() || title })
  }

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            onClick={open}
            className={cn(
              // font-sans: the chip also appears inside the monospaced output
              // of a tool, where it would inherit the <pre> font.
              "mx-0.5 inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 align-baseline font-sans text-[0.7rem] font-medium",
              memory
                ? "bg-primary/10 text-primary hover:bg-primary/20"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          />
        }
      >
        <BrainIcon className="size-2.5" />
        {title}
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-80 p-3">
        {memory ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <BrainIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 text-xs leading-snug font-medium">
                {memory.title?.trim() || shortLabel(memory.text, 80)}
              </p>
            </div>
            <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">{memory.text}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className={cn("px-1.5 py-0 text-[10px]", KIND_BADGE[memory.kind])}>
                {t(`memories.kinds.${memory.kind}`, { defaultValue: KIND_LABEL[memory.kind] })}
              </Badge>
              {memory.category && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  {t(`memories.categories.${memory.category}`, { defaultValue: CATEGORY_LABEL[memory.category] })}
                </Badge>
              )}
              {memory.hasDoc && <FileTextIcon className="size-3 text-muted-foreground" />}
              {memory.tags.slice(0, 5).map((tag) => (
                <span key={tag} className="text-[10px] text-muted-foreground">#{tag}</span>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 border-t pt-2 text-[10px] text-muted-foreground">
              <span>{t("memories.uses", { count: memory.hits })}</span>
              <button
                type="button"
                onClick={open}
                className="cursor-pointer font-medium text-primary hover:underline"
              >
                {t("memories.openInPanel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <p>{t("memories.notFound")}</p>
            <p className="font-mono break-all">{memoryId}</p>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

/**
 * RAW text (tool output) with the memory ids becoming chips. The splitting
 * lives in citations.ts — here only the drawing.
 */
export function MemoryIdText({ text, sessionId }: { text: string; sessionId?: string }) {
  const parts = useMemo(() => splitMemoryIds(text), [text])
  if (parts.length < 2) return <>{text}</>

  return (
    <>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <MemoryCitation key={i} memoryId={part.memoryId} label={part.memoryId} sessionId={sessionId} />
        ),
      )}
    </>
  )
}
