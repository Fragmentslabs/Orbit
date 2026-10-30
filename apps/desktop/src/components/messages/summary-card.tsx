import { useState } from "react"
import { ChevronDownIcon, NotebookPen } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@shared/chat"
import { messageText } from "@/src/lib/message-utils"
import { summaryBody } from "@/src/lib/summary"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useTranslation } from "react-i18next"

/**
 * Collapsible card of the compaction message (summary: true): the previous
 * history was summarized to free context — the full text stays here.
 */
export function SummaryCard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="not-prose my-2 w-full">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <NotebookPen className="size-3.5 shrink-0" />
        <span className="flex-1">
          {message.continuation ? t("chat.summaryCardContinuation") : t("chat.summaryCard")}
        </span>
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="rounded-b-lg border border-t-0 bg-muted/10 px-3 py-2 text-sm">
          <AssistantMarkdown muted>{summaryBody(messageText(message))}</AssistantMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
