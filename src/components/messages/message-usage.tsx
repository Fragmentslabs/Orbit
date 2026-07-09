import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { TokenUsage } from "@/shared/chat"
import { formatCost, formatTokens } from "@/src/lib/format"

/**
 * Badge discreto de tokens/custo no rodapé da mensagem do assistente.
 * Detalhes (reasoning, cache) ficam no tooltip.
 */

export function MessageUsage({ tokens }: { tokens: TokenUsage }) {
  const summary = [
    `${formatTokens(tokens.input)} in`,
    `${formatTokens(tokens.output)} out`,
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
          <span>Entrada: {tokens.input.toLocaleString("pt-BR")} tokens</span>
          <span>Saída: {tokens.output.toLocaleString("pt-BR")} tokens</span>
          {tokens.reasoning > 0 && <span>Reasoning: {tokens.reasoning.toLocaleString("pt-BR")}</span>}
          {tokens.cacheRead > 0 && <span>Cache lido: {tokens.cacheRead.toLocaleString("pt-BR")}</span>}
          {tokens.cacheWrite > 0 && <span>Cache gravado: {tokens.cacheWrite.toLocaleString("pt-BR")}</span>}
          {tokens.cost !== undefined && <span>Custo: {formatCost(tokens.cost)}</span>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
