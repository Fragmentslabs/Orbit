import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSessionStore } from "@/src/stores/session-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { formatTokens } from "@/src/lib/format"
import { chatApi } from "@/src/lib/ipc"
import { Button } from "@/components/ui/button"
import type { TokenUsage } from "@shared/chat"

// Usa o usage do último step (chamada real mais recente) quando disponível —
// é o tamanho real do contexto atual. `input`/`output` no topo do TokenUsage
// somam todos os steps do turno (inflado por idas-e-vindas de tool) e só
// servem de fallback para mensagens persistidas antes desse campo existir.
function sumTokens(u: TokenUsage): number {
  if (u.lastStep) return (u.lastStep.input ?? 0) + (u.lastStep.output ?? 0)
  return (u.input ?? 0) + (u.output ?? 0)
}

const R = 7
const C = 2 * Math.PI * R

const NO_MSGS: import("@shared/chat").ChatMessage[] = []

export function ContextMeter({ sessionId }: { sessionId?: string }) {
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const model = useProviderStore((s) => {
    const sel = s.selectedModel
    return sel ? s.catalog[sel.providerId]?.models[sel.modelId] : undefined
  })

  const limit = model?.limit?.context

  const { lastTokens, compacted } = useMemo(() => {
    let lastSummary = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].summary) lastSummary = i
    }
    const found = [...messages].reverse().find((m) => m.role === "assistant" && m.tokens)?.tokens
    return { lastTokens: found, compacted: lastSummary >= 0 }
  }, [messages])

  const used = lastTokens ? sumTokens(lastTokens) : 0
  if (used === 0 && !limit) return null

  // Idem sumTokens: prioriza o último step (contexto real atual) sobre o
  // total do turno.
  const displayInput = lastTokens?.lastStep?.input ?? lastTokens?.input ?? 0
  const displayOutput = lastTokens?.lastStep?.output ?? lastTokens?.output ?? 0

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
        <div className="space-y-2 text-xs w-full">
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
              {lastTokens && (
                <div className="space-y-1 text-[10px] text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Entrada</span>
                    <span className="tabular-nums">{formatTokens(displayInput)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Saída</span>
                    <span className="tabular-nums">{formatTokens(displayOutput)}</span>
                  </div>
                  {lastTokens.reasoning > 0 && (
                    <div className="flex justify-between">
                      <span>Reasoning</span>
                      <span className="tabular-nums">{formatTokens(lastTokens.reasoning)}</span>
                    </div>
                  )}
                </div>
              )}
              {compacted && (
                <p className="text-[10px] text-muted-foreground/60">Compactado — histórico anterior resumido</p>
              )}
              {!compacted && pct >= 0.85 && pct < 1 && (
                <p className="text-[10px] text-amber-500">Próximo do limite — o histórico será compactado em breve</p>
              )}
              {!compacted && atLimit && (
                <p className="text-[10px] text-destructive">Limite atingido — a compactação automática falhou</p>
              )}
              <div className="pt-1 border-t border-border" />
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={() => sessionId && chatApi.compact(sessionId)}
              >
                Compactar histórico agora
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span>Contexto usado</span>
                <span className="tabular-nums">{formatTokens(used)} tokens</span>
              </div>
              {lastTokens && (
                <div className="space-y-1 text-[10px] text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Entrada</span>
                    <span className="tabular-nums">{formatTokens(displayInput)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Saída</span>
                    <span className="tabular-nums">{formatTokens(displayOutput)}</span>
                  </div>
                  {lastTokens.reasoning > 0 && (
                    <div className="flex justify-between">
                      <span>Reasoning</span>
                      <span className="tabular-nums">{formatTokens(lastTokens.reasoning)}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="pt-1 border-t border-border" />
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={() => sessionId && chatApi.compact(sessionId)}
              >
                Compactar histórico agora
              </Button>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
