import { useTranslation } from "react-i18next"
import { FolderKanban, MessageSquare, Sun } from "lucide-react"
import type { AnalyticsSummary } from "@shared/analytics"
import { useWorkspace } from "@/lib/workspace-context"
import { formatCost, formatTokens } from "@/src/lib/format"
import { useSessionStore } from "@/src/stores/session-store"
import { dateKey } from "@/src/components/usage/usage-utils"
import {
  compactHours,
  NativeSparkline,
  NativeStat,
  NativeWidgetEmpty,
  NativeWidgetShell,
  NativeWidgetSkeleton,
  useUsageSummary,
  type NativeWidgetProps,
} from "./widget-bits"

/** The last seven calendar days, a day without work counted as zero. */
function lastWeek(summary: AnalyticsSummary | null): number[] {
  const byDate = new Map((summary?.days ?? []).map((day) => [day.date, day.totalHours]))
  const today = new Date()
  const values: number[] = []
  for (let back = 6; back >= 0; back--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)
    values.push(byDate.get(dateKey(day)) ?? 0)
  }
  return values
}

function sameDirectory(a?: string, b?: string): boolean {
  if (!a || !b) return false
  const clean = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase()
  return clean(a) === clean(b)
}

/**
 * Today: the number the person checks to know whether the day is already expensive. The
 * week behind it is context — a bar for each of the last seven days.
 */
export function UsageDayWidget({ compact, preview }: NativeWidgetProps) {
  const { t } = useTranslation()
  const summary = useUsageSummary(!preview)
  if (!summary) return <NativeWidgetSkeleton />

  const today = summary.days.find((day) => day.date === dateKey(new Date()))
  const hours = today?.totalHours ?? 0
  const tokens = today?.totalTokens ?? 0
  const messages = today?.totalMessages ?? 0
  const cost = today?.totalCost ?? 0
  const week = lastWeek(summary)

  return (
    <NativeWidgetShell
      title={t("widgets.nativeWidgets.usageDay.name")}
      icon={Sun}
      badge={cost > 0 ? formatCost(cost) : undefined}
    >
      {compact ? (
        <div className="flex h-full items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[18px] font-semibold leading-none tabular-nums">{compactHours(hours)}</p>
            <p className="mt-1 truncate text-[9px] text-muted-foreground">
              {formatTokens(tokens)} · {messages} {t("widgets.nativeWidgets.usage.chats")}
            </p>
          </div>
          <NativeSparkline values={week} className="h-8 w-12 shrink-0" />
        </div>
      ) : (
        <div className="flex h-full flex-col gap-2">
          <div className="flex items-baseline gap-1.5">
            <p className="text-[22px] font-semibold leading-none tabular-nums">{compactHours(hours)}</p>
            <span className="text-[9px] text-muted-foreground">{t("widgets.nativeWidgets.usage.time")}</span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <NativeStat value={formatTokens(tokens)} label={t("widgets.nativeWidgets.usage.tokens")} />
            <NativeStat value={String(messages)} label={t("widgets.nativeWidgets.usage.chats")} />
            <NativeStat value={formatCost(cost)} label={t("widgets.nativeWidgets.usage.cost")} />
          </div>
          <div className="mt-auto">
            <NativeSparkline values={week} className="h-6 w-full" />
            <p className="mt-1 text-[8px] text-muted-foreground">{t("widgets.nativeWidgets.usage.week")}</p>
          </div>
        </div>
      )}
    </NativeWidgetShell>
  )
}

/**
 * The project of the conversation that is open — the same one the agent is working in. When
 * there is none (a chat without a folder), it falls back to the project that spent the most,
 * so the card is never blank.
 */
export function UsageProjectWidget({ compact, preview }: NativeWidgetProps) {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeIds[mode])
  const summary = useUsageSummary(!preview)

  if (!summary) return <NativeWidgetSkeleton />

  const session = activeId ? sessions.find((item) => item.id === activeId) : undefined
  const project =
    summary.byProject.find((item) => sameDirectory(item.directory, session?.directory)) ?? summary.byProject[0]
  const name = project?.directory ? project.name : t("widgets.nativeWidgets.usage.noProject")
  const hours = project?.hours ?? 0
  const tokens = project?.tokens ?? 0
  const chats = project?.sessions ?? 0
  const cost = project?.cost ?? 0

  return (
    <NativeWidgetShell
      title={t("widgets.nativeWidgets.usageProject.name")}
      icon={FolderKanban}
      badge={cost > 0 ? formatCost(cost) : undefined}
    >
      {compact ? (
        <div className="flex h-full min-w-0 flex-col justify-center gap-1">
          <p className="truncate text-[11px] font-medium leading-tight">{name}</p>
          <p className="truncate text-[15px] font-semibold leading-none tabular-nums">
            {compactHours(hours)}
            <span className="ml-1.5 text-[9px] font-normal text-muted-foreground">{formatTokens(tokens)}</span>
          </p>
        </div>
      ) : (
        <div className="flex h-full flex-col gap-2">
          <p className="truncate text-[11px] font-medium leading-tight">{name}</p>
          <div className="flex items-baseline gap-1.5">
            <p className="text-[22px] font-semibold leading-none tabular-nums">{compactHours(hours)}</p>
            <span className="text-[9px] text-muted-foreground">{t("widgets.nativeWidgets.usage.time")}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <NativeStat value={formatTokens(tokens)} label={t("widgets.nativeWidgets.usage.tokens")} />
            <NativeStat value={String(chats)} label={t("widgets.nativeWidgets.usage.chats")} />
          </div>
          <div className="mt-auto flex items-center justify-between text-[9px] text-muted-foreground">
            <span className="truncate">{t("widgets.nativeWidgets.usage.total")}</span>
            <span className="shrink-0 tabular-nums">{formatCost(cost)}</span>
          </div>
        </div>
      )}
    </NativeWidgetShell>
  )
}

/** What the conversation on screen spent, summed over every day it ran. */
export function UsageChatWidget({ compact, preview }: NativeWidgetProps) {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeIds[mode])
  const summary = useUsageSummary(!preview)
  const session = activeId ? sessions.find((item) => item.id === activeId) : undefined

  if (!summary) return <NativeWidgetSkeleton />
  if (!session) {
    return (
      <NativeWidgetShell title={t("widgets.nativeWidgets.usageChat.name")} icon={MessageSquare}>
        <NativeWidgetEmpty>{t("widgets.nativeWidgets.usage.noChat")}</NativeWidgetEmpty>
      </NativeWidgetShell>
    )
  }

  const entries = summary.sessions?.filter((item) => item.id === session.id) ?? []
  const hours = entries.reduce((sum, item) => sum + item.hours, 0)
  const tokens = entries.reduce((sum, item) => sum + item.tokens, 0)
  const messages = entries.reduce((sum, item) => sum + item.messages, 0)
  const cost = entries.reduce((sum, item) => sum + item.cost, 0)

  return (
    <NativeWidgetShell
      title={t("widgets.nativeWidgets.usageChat.name")}
      icon={MessageSquare}
      badge={cost > 0 ? formatCost(cost) : undefined}
    >
      {compact ? (
        <div className="flex h-full min-w-0 flex-col justify-center gap-1">
          <p className="truncate text-[11px] font-medium leading-tight">{session.title}</p>
          <p className="truncate text-[9px] text-muted-foreground">
            {compactHours(hours)} · {formatTokens(tokens)} · {messages} {t("widgets.nativeWidgets.usage.replies")}
          </p>
        </div>
      ) : (
        <div className="flex h-full flex-col gap-2">
          <p className="line-clamp-2 text-[11px] font-medium leading-tight">{session.title}</p>
          <div className="grid grid-cols-3 gap-1.5">
            <NativeStat value={compactHours(hours)} label={t("widgets.nativeWidgets.usage.time")} />
            <NativeStat value={formatTokens(tokens)} label={t("widgets.nativeWidgets.usage.tokens")} />
            <NativeStat value={String(messages)} label={t("widgets.nativeWidgets.usage.replies")} />
          </div>
          <div className="mt-auto flex items-center justify-between text-[9px] text-muted-foreground">
            <span>
              {entries.length === 0
                ? "—"
                : entries.length === 1
                  ? t("widgets.nativeWidgets.usage.oneDay")
                  : t("widgets.nativeWidgets.usage.days", { count: entries.length })}
            </span>
            <span className="tabular-nums">{formatCost(cost)}</span>
          </div>
        </div>
      )}
    </NativeWidgetShell>
  )
}
