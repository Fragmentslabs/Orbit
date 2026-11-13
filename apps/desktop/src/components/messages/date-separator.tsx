import { useTranslation } from "react-i18next"

/** true when `curr` falls on a different calendar day than `prev` (or is the first message). */
export function isNewDay(prev: number | undefined, curr: number): boolean {
  if (prev === undefined) return true
  const a = new Date(prev)
  const b = new Date(curr)
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()
}

export function dayKey(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * The date between two days of the conversation.
 *
 * "pill" is the WhatsApp-style badge the chats use; "line" is the quiet line of the routine
 * chat — the full date between two hairlines, which reads as the title of the execution.
 */
export function DateSeparator({ timestamp, variant = "pill" }: {
  timestamp: number
  variant?: "pill" | "line"
}) {
  const { t, i18n } = useTranslation()

  const date = new Date(timestamp)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)

  const isToday = isNewDay(now.getTime(), timestamp) === false
  const isYesterday = !isToday && isNewDay(yesterday.getTime(), timestamp) === false

  if (variant === "line") {
    const full = date.toLocaleDateString(i18n.language, { weekday: "long", day: "numeric", month: "long" })
    const label = full.charAt(0).toUpperCase() + full.slice(1)
    return (
      <div className="my-4 flex items-center gap-3 text-[10px] text-muted-foreground/70">
        <span className="h-px flex-1 bg-border/60" />
        <span className="select-none whitespace-nowrap">{label}</span>
        <span className="h-px flex-1 bg-border/60" />
      </div>
    )
  }

  const label = isToday
    ? t("dateSeparator.today")
    : isYesterday
      ? t("dateSeparator.yesterday")
      : date.toLocaleDateString(i18n.language, { day: "2-digit", month: "2-digit", year: "numeric" })

  return (
    <div className="sticky top-8 z-10 my-3 flex justify-center">
      <span className="select-none rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
        {label}
      </span>
    </div>
  )
}
