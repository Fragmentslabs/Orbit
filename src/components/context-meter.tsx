import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSessionStore } from "@/src/stores/session-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { formatTokens } from "@/src/lib/format"
import type { TokenUsage } from "@/shared/chat"

function sumTokens(u: TokenUsage): number {
  return (u.input ?? 0) + (u.output ?? 0)
}

const R = 7
const C = 2 * Math.PI * R

const NO_MSGS: import("@/shared/chat").ChatMessage[] = []

export function ContextMeter({ sessionId }: { sessionId?: string }) {
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const model = useProviderStore((s) => {
    const sel = s.selectedModel
    return sel ? s.catalog[sel.providerId]?.models[sel.modelId] : undefined
  })

  const limit = model?.limit?.context

  const { accumulated, compacted } = useMemo(() => {
    let lastSummary = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].summary) lastSummary = i
    }
    const slice = messages.slice(lastSummary + 1)
    const acc: TokenUsage = slice.reduce(
      (a, m) => {
        if (m.role === "assistant" && m.tokens) {
          a.input += m.tokens.input
          a.output += m.tokens.output
          a.reasoning += m.tokens.reasoning
          a.cacheRead += m.tokens.cacheRead
          a.cacheWrite += m.tokens.cacheWrite
        }
        return a
      },
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    )
    return { accumulated: acc, compacted: lastSummary >= 0 }
  }, [messages])

  const used = sumTokens(accumulated)
  if (used === 0 && !limit) return null

  const pct = limit ? Math.min(used / limit, 1) : 0
  const atLimit = pct >= 1

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
              atLimit
                ? "text-destructive hover:text-destructive/80"
                : "text-muted-foreground/50 hover:text-foreground",
            )}
          >
            {limit ? (
              <>
                <svg className="size-4 -rotate-90" viewBox="0 0 16 16">
                  <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" className="text-muted-foreground/30" strokeWidth="2" />
                  <circle
                    cx="8" cy="8" r={R} fill="none" stroke="currentColor"
                    className={atLimit ? "text-destructive" : "text-primary"}
                    strokeWidth="2" strokeLinecap="round"
                    strokeDasharray={C}
                    strokeDashoffset={C * (1 - pct)}
                  />
                </svg>
                <span className="tabular-nums">{Math.round(pct * 100)}%</span>
              </>
            ) : (
              <span className="tabular-nums">{formatTokens(used)}</span>
            )}
          </button>
        }
      />
      <TooltipContent side="top" align="center" sideOffset={6} className="w-auto min-w-48 bg-popover text-popover-foreground">
        <div className="space-y-2 text-xs">
          {limit ? (
            <>
              <div className="flex items-center justify-between">
                <span>Contexto</span>
                <span className="tabular-nums">
                  {formatTokens(used)} / {formatTokens(limit)}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20">
                <div
                  className={cn("h-full rounded-full transition-all", atLimit ? "bg-destructive" : "bg-primary")}
                  style={{ width: `${Math.min(pct * 100, 100)}%` }}
                />
              </div>
              <div className="space-y-1 text-[10px] text-muted-foreground">
                <div className="flex justify-between">
                  <span>Entrada</span>
                  <span className="tabular-nums">{formatTokens(accumulated.input)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Saída</span>
                  <span className="tabular-nums">{formatTokens(accumulated.output)}</span>
                </div>
                {accumulated.reasoning > 0 && (
                  <div className="flex justify-between">
                    <span>Reasoning</span>
                    <span className="tabular-nums">{formatTokens(accumulated.reasoning)}</span>
                  </div>
                )}
              </div>
              {compacted && (
                <p className="text-[10px] text-muted-foreground/60">Compactado — histórico anterior resumido</p>
              )}
              {!compacted && pct >= 0.85 && pct < 1 && (
                <p className="text-[10px] text-amber-500">Próximo do limite — o histórico será compactado em breve</p>
              )}
              {!compacted && atLimit && (
                <p className="text-[10px] text-destructive">Limite atingido — a próxima mensagem compactará o histórico</p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span>Contexto usado</span>
                <span className="tabular-nums">{formatTokens(used)} tokens</span>
              </div>
              <div className="space-y-1 text-[10px] text-muted-foreground">
                <div className="flex justify-between">
                  <span>Entrada</span>
                  <span className="tabular-nums">{formatTokens(accumulated.input)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Saída</span>
                  <span className="tabular-nums">{formatTokens(accumulated.output)}</span>
                </div>
                {accumulated.reasoning > 0 && (
                  <div className="flex justify-between">
                    <span>Reasoning</span>
                    <span className="tabular-nums">{formatTokens(accumulated.reasoning)}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
