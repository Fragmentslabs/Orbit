import { useTranslation } from "react-i18next"

/** true quando `curr` cai em um dia civil diferente de `prev` (ou é a primeira mensagem). */
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

/** Badge de data estilo WhatsApp: "Hoje" / "Ontem" / data completa. */
export function DateSeparator({ timestamp }: { timestamp: number }) {
  const { t, i18n } = useTranslation()

  const date = new Date(timestamp)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)

  const isToday = isNewDay(now.getTime(), timestamp) === false
  const isYesterday = !isToday && isNewDay(yesterday.getTime(), timestamp) === false

  const label = isToday
    ? t("dateSeparator.today")
    : isYesterday
      ? t("dateSeparator.yesterday")
      : date.toLocaleDateString(i18n.language, { day: "2-digit", month: "2-digit", year: "numeric" })

  return (
    <div className="sticky top-12 z-10 my-3 flex justify-center">
      <span className="select-none rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
        {label}
      </span>
    </div>
  )
}
