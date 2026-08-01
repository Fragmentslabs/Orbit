import { useTranslation } from "react-i18next"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { TokenUsage } from "@shared/chat"
import { formatCost, formatTokens } from "@/src/lib/format"

/**
 * Badge discreto de tokens/custo no rodapé da mensagem do assistente.
 * Detalhes (reasoning, cache) ficam no tooltip.
 */

export function MessageUsage({ tokens }: { tokens: TokenUsage }) {
  const { t, i18n } = useTranslation()
  const nf = new Intl.NumberFormat(i18n.language)
  const summary = [
    t("usage.inputIn", { count: formatTokens(tokens.input) }),
    t("usage.outputOut", { count: formatTokens(tokens.output) }),
    tokens.cost !== undefined ? formatCost(tokens.cost) : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="select-none px-1 text-[11px] tabular-nums text-muted-foreground/70" />
        }
      >
        {summary}
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="flex flex-col gap-0.5 text-xs">
          <span>{t("usage.inputLine", { count: nf.format(tokens.input) })}</span>
          <span>{t("usage.outputLine", { count: nf.format(tokens.output) })}</span>
          {tokens.reasoning > 0 && <span>{t("usage.reasoningLine", { count: nf.format(tokens.reasoning) })}</span>}
          {tokens.cacheRead > 0 && <span>{t("usage.cacheReadLine", { count: nf.format(tokens.cacheRead) })}</span>}
          {tokens.cacheWrite > 0 && <span>{t("usage.cacheWriteLine", { count: nf.format(tokens.cacheWrite) })}</span>}
          {tokens.cost !== undefined && <span>{t("usage.costLine", { cost: formatCost(tokens.cost) })}</span>}
          {tokens.lastStep && (
            <>
              <div className="my-0.5 border-t border-border" />
              <span className="text-muted-foreground">
                {t("usage.currentContext", { count: nf.format(tokens.lastStep.input + tokens.lastStep.output) })}
              </span>
              <span className="text-muted-foreground/70">
                {t("usage.note")}
              </span>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
