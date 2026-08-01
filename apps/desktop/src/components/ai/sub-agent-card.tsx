import { useTranslation } from "react-i18next"
import { BotIcon, XCircleIcon } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"

/**
 * Card minimalista de subagente (tool subagent): mostra a tarefa delegada,
 * shimmer enquanto roda em segundo plano e o resultado inline ao concluir.
 * Subagentes são efêmeros — não têm chat próprio nem botão de expandir.
 */
export function SubAgentCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const task = typeof part.input?.task === "string" ? part.input.task : t("subagent.defaultTask")

  return (
    <div className="not-prose my-1.5 w-full rounded-lg border bg-muted/40 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {part.state === "error" ? (
          <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{task}</span>
      </div>
      {part.state === "running" && (
        <Shimmer className="mt-1.5 block">{t("subagent.running")}</Shimmer>
      )}
      {part.state === "error" && part.error && (
        <p className="mt-1.5 text-destructive">{part.error}</p>
      )}
      {part.state === "done" && part.output && (
        <p className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
          {part.output}
        </p>
      )}
    </div>
  )
}
