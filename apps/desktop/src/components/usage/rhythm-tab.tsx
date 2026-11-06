import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { AnalyticsSummary } from "@shared/analytics"
import { Card, CardHeader, EmptyNote, KpiCard } from "./usage-ui"
import { WEEKDAY_ORDER, formatHours, hoursByWeekday, percent, spanOfDays } from "./usage-utils"

export function RhythmTab({ data }: { data: AnalyticsSummary }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language

  const weekdays = useMemo(() => hoursByWeekday(data.days), [data.days])
  const maxDay = Math.max(...weekdays, Number.EPSILON)

  if (data.days.length === 0) return <EmptyNote>{t("analytics.noData")}</EmptyNote>

  const stats = [
    { label: t("analytics.stats.peakHour"), value: `${data.peakHour}h` },
    { label: t("analytics.stats.currentStreak"), value: t("analytics.stats.days", { count: data.currentStreak }) },
    { label: t("analytics.stats.longestStreak"), value: t("analytics.stats.days", { count: data.longestStreak }) },
    { label: t("analytics.stats.activeDays"), value: t("usage.rhythm.activeOf", { active: data.activeDays, total: spanOfDays(data.days) }) },
    { label: t("analytics.stats.sessions"), value: String(data.totalSessions) },
    { label: t("analytics.stats.messages"), value: String(data.totalMessages) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 @[48rem]:grid-cols-2">
        <Card>
          <CardHeader title={t("usage.rhythm.byWeekday")} subtitle={t("usage.rhythm.byWeekdayHint")} />
          <div className="flex flex-col gap-2.5">
            {WEEKDAY_ORDER.map((day) => (
              <div key={day} className="flex items-center gap-3">
                <span className="w-10 text-xs capitalize text-muted-foreground">
                  {new Date(2026, 0, 4 + day).toLocaleDateString(locale, { weekday: "short" })}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${percent(weekdays[day], maxDay)}%` }} />
                </span>
                <span className="w-14 text-right text-xs tabular-nums">{formatHours(weekdays[day], locale)}</span>
              </div>
            ))}
          </div>
        </Card>
        <div className="grid grid-cols-2 content-start gap-3">
          {stats.map((s) => (
            <KpiCard key={s.label} label={s.label} value={s.value} />
          ))}
        </div>
      </div>

      <Card>
        <CardHeader title={t("analytics.hoursByProjectInfoTitle")} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("analytics.hoursByProjectInfo")}</p>
      </Card>
    </div>
  )
}
