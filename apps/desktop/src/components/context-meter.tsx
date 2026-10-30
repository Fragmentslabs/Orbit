import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSessionStatus, useSessionStore } from "@/src/stores/session-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { formatTokens } from "@/src/lib/format"
import { chatApi } from "@/src/lib/ipc"
import { Button } from "@/components/ui/button"
import type { TokenUsage } from "@shared/chat"

// Uses the usage of the last step (most recent real call) when available —
// it is the real size of the current context. `input`/`output` at the top of TokenUsage
// add up all the steps of the turn (inflated by tool round-trips) and only
// serve as a fallback for messages persisted before this field existed.
function sumTokens(u: TokenUsage): number {
  if (u.lastStep) return (u.lastStep.input ?? 0) + (u.lastStep.output ?? 0)
  return (u.input ?? 0) + (u.output ?? 0)
}

const R = 7
const C = 2 * Math.PI * R

const NO_MSGS: import("@shared/chat").ChatMessage[] = []

export function ContextMeter({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  // Compacting with the turn running does not happen (the main process refuses): the summary would be
  // made from an old copy of the history and would be lost at the end of the turn.
  const status = useSessionStatus(sessionId)
  const turnRunning = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
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

  // The live value (on every step of the turn in progress, or the size of what
  // the provider has just refused) is worth more than the `tokens` of the last finished
  // reply — that one only arrives at the end and left the meter stuck in a long
  // turn, showing 23% while the real request went past 900k.
  const used = live ? live.input + live.output : lastTokens ? sumTokens(lastTokens) : 0
  if (used === 0 && !limit) return null

  // Same for sumTokens: it prioritizes the last step (real current context) over the
  // total do turno.
  const displayInput = live ? live.input : (lastTokens?.lastStep?.input ?? lastTokens?.input ?? 0)
  const displayOutput = live ? live.output : (lastTokens?.lastStep?.output ?? lastTokens?.output ?? 0)
  const showBreakdown = Boolean(live || lastTokens)
  // Cache of the current call: how much of the input above came from the provider cache
  // and how much was written into it. The pre-send estimate does not have that data.
  const cacheRead = live ? live.cacheRead : lastTokens?.lastStep?.cacheRead
  const cacheWrite = live ? live.cacheWrite : lastTokens?.lastStep?.cacheWrite

  const row = (label: string, value: number, indent = false) => (
    <div className={cn("flex justify-between gap-4", indent && "pl-2 text-muted-foreground/80")}>
      <span>{label}</span>
      <span className="tabular-nums">{formatTokens(value)}</span>
    </div>
  )
  // Input = no cache + read from cache + written to cache. The three add up to the
  // total, so the split goes as sub-lines (the cost one is different from them).
  const hasCache = (cacheRead ?? 0) + (cacheWrite ?? 0) > 0
  const noCache = Math.max(0, displayInput - (cacheRead ?? 0) - (cacheWrite ?? 0))
  // Reasoning is part of the output of THIS step: only the step's one matches the output shown.
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
                disabled={turnRunning}
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
                disabled={turnRunning}
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
