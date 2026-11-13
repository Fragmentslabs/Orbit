import { useEffect, useState, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import type { AnalyticsSummary } from "@shared/analytics"
import { cn } from "@/lib/utils"
import { startUsageWidgetsWatch, useUsageWidgetsStore } from "@/src/stores/usage-widgets-store"

/**
 * Small shared pieces of the native widgets. They live inside a 72px cell, so every number
 * is tabular and every label is smaller than the app's usual one — the widget has to be read
 * from across the room, not inspected.
 */

/** What every native renderer receives: the cell is half a widget or a full one. */
export interface NativeWidgetProps {
  /** 2x1: one row of content instead of the full layout. */
  compact: boolean
  /** Drawn in the picker, not on the board: it must not load anything by itself. */
  preview?: boolean
}

/** The usage summary, loading it when the widget is really on the board. */
export function useUsageSummary(enabled = true): AnalyticsSummary | null {
  const summary = useUsageWidgetsStore((s) => s.summary)
  const load = useUsageWidgetsStore((s) => s.load)

  useEffect(() => {
    if (!enabled) return
    startUsageWidgetsWatch()
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(timer)
  }, [enabled, load])

  return summary
}

/** A clock that re-renders the widget while it is open ("in 3 min" must not freeze). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Hours → "48 min", "2h 05min". The same shape the usage screen uses. */
export function compactHours(hours: number): string {
  const minutes = Math.round(hours * 60)
  if (minutes < 1) return "0 min"
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}min`
}

/** A moment relative to now, in the app's language: "in 2 hr." / "há 2 min". */
export function relativeMoment(ts: number, now: number, locale: string): string {
  const diff = ts - now
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second")
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute")
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour")
  return rtf.format(Math.round(diff / 86_400_000), "day")
}

export function NativeWidgetShell({
  title,
  icon: Icon,
  badge,
  children,
  className,
}: {
  title: string
  icon: LucideIcon
  badge?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex size-full flex-col gap-1 overflow-hidden p-2", className)}>
      <header className="flex shrink-0 items-center gap-1">
        <Icon className="size-3 shrink-0 text-primary" />
        <span className="truncate text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
        {badge !== undefined && <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{badge}</span>}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** One number over its label, the pair every usage widget repeats. */
export function NativeStat({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="truncate text-[13px] font-semibold leading-none tabular-nums">{value}</p>
      <p className="mt-0.5 truncate text-[8px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  )
}

/** Seven bars, highest day at full height. A gap is a bar with the muted color. */
export function NativeSparkline({ values, className }: { values: readonly number[]; className?: string }) {
  const max = Math.max(...values, 0.0001)
  return (
    <div className={cn("flex items-end gap-[2px]", className)} aria-hidden>
      {values.map((value, index) => (
        <span
          key={index}
          className={cn("min-w-0 flex-1 rounded-[1px]", value > 0 ? "bg-primary/75" : "bg-muted")}
          style={{ height: `${Math.max(value > 0 ? 18 : 8, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  )
}

export function NativeWidgetEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-full items-center justify-center px-1 text-center text-[10px] leading-tight text-muted-foreground">
      {children}
    </div>
  )
}

/** The shape of a widget while its numbers are on the way. */
export function NativeWidgetSkeleton() {
  return (
    <div className="flex size-full flex-col justify-center gap-1.5 p-2">
      <span className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      <span className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <span className="h-2 w-full animate-pulse rounded bg-muted" />
    </div>
  )
}
