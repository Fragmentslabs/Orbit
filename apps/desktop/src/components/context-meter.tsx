import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSessionStore } from "@/src/stores/session-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
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
  const { t } = useTranslation()
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const live = useSessionStore((s) => (sessionId ? s.liveContext[sessionId] : undefined))
  const selected = useSessionModel(sessionId)
  const model = useProviderStore((s) => {
    if (!selected) return undefined
    return s.catalog[selected.providerId]?.models[selected.modelId]
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

  // O valor ao vivo (a cada passo do turno em andamento, ou o tamanho do que
  // o provedor acabou de recusar) vale mais que o `tokens` da última resposta
  // concluída — esse só chega no fim e deixava o medidor parado num turno
  // longo, mostrando 23% enquanto o request real passava de 900k.
  const used = live ? live.input + live.output : lastTokens ? sumTokens(lastTokens) : 0
  if (used === 0 && !limit) return null

  // Idem sumTokens: prioriza o último step (contexto real atual) sobre o
  // total do turno.
  const displayInput = live ? live.input : (lastTokens?.lastStep?.input ?? lastTokens?.input ?? 0)
  const displayOutput = live ? live.output : (lastTokens?.lastStep?.output ?? lastTokens?.output ?? 0)
  const showBreakdown = Boolean(live || lastTokens)
  // Cache da chamada atual: quanto da entrada acima veio do cache do provedor
  // e quanto foi gravado nele. A estimativa pré-envio não tem esse dado.
  const cacheRead = live ? live.cacheRead : lastTokens?.lastStep?.cacheRead
  const cacheWrite = live ? live.cacheWrite : lastTokens?.lastStep?.cacheWrite

  const row = (label: string, value: number, indent = false) => (
    <div className={cn("flex justify-between gap-4", indent && "pl-2 text-muted-foreground/80")}>
      <span>{label}</span>
      <span className="tabular-nums">{formatTokens(value)}</span>
    </div>
  )
  // Entrada = sem cache + lido do cache + gravado no cache. Os três somam o
  // total, então a divisão vai como sub-linhas (a de custo é diferente entre si).
  const hasCache = (cacheRead ?? 0) + (cacheWrite ?? 0) > 0
  const noCache = Math.max(0, displayInput - (cacheRead ?? 0) - (cacheWrite ?? 0))
  // Raciocínio é parte da saída DESTE passo: só o do passo bate com o output mostrado.
  const stepReasoning = live ? undefined : lastTokens?.lastStep?.reasoning
  const breakdown = (
    <div className="space-y-1 text-[10px] text-muted-foreground">
      {row(t("usage.input"), displayInput)}
      {hasCache && row(`↳ ${t("usage.noCache")}`, noCache, true)}
      {(cacheRead ?? 0) > 0 && row(`↳ ${t("usage.cacheRead")}`, cacheRead ?? 0, true)}
      {(cacheWrite ?? 0) > 0 && row(`↳ ${t("usage.cacheWrite")}`, cacheWrite ?? 0, true)}
      {row(t("usage.output"), displayOutput)}
      {stepReasoning !== undefined && stepReasoning > 0 && row(`↳ ${t("usage.reasoning")}`, stepReasoning, true)}
    </div>
  )
  const liveNote = live && (
    <p className="text-[10px] text-muted-foreground/60">
      {live.estimated ? t("usage.estimated") : t("usage.live")}
    </p>
  )

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
      <TooltipContent side="top" align="center" sideOffset={6} className="w-56 bg-popover text-popover-foreground">
        <div className="space-y-2 text-xs w-full">
          {limit ? (
            <>
              <div className="flex items-center justify-between">
                <span>{t("usage.context")}</span>
                <span className="tabular-nums">
                  {live?.estimated ? "≈ " : ""}{formatTokens(used)} / {formatTokens(limit)}
                </span>
              </div>
              {liveNote}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20">
                <div
                  className={cn("h-full rounded-full transition-all", atLimit ? "bg-destructive" : "bg-primary")}
                  style={{ width: `${Math.min(pct * 100, 100)}%` }}
                />
              </div>
              {showBreakdown && breakdown}
              {compacted && (
                <p className="text-[10px] text-muted-foreground/60">{t("usage.compacted")}</p>
              )}
              {!compacted && pct >= 0.85 && pct < 1 && (
                <p className="text-[10px] text-amber-500">{t("usage.nearLimit")}</p>
              )}
              {!compacted && atLimit && (
                <p className="text-[10px] text-destructive">{t("usage.atLimit")}</p>
              )}
              <div className="pt-1 border-t border-border" />
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={() => sessionId && chatApi.compact(sessionId)}
              >
                {t("usage.compactNow")}
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span>{t("usage.contextUsed")}</span>
                <span className="tabular-nums">
                  {live?.estimated ? "≈ " : ""}{formatTokens(used)} {t("usage.tokensWord")}
                </span>
              </div>
              {liveNote}
              {showBreakdown && breakdown}
              <div className="pt-1 border-t border-border" />
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-7"
                onClick={() => sessionId && chatApi.compact(sessionId)}
              >
                {t("usage.compactNow")}
              </Button>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
