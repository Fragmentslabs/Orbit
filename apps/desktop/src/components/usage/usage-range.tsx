import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarIcon } from "lucide-react"
import { format } from "date-fns"
import { enUS, ptBR as dfPtBR } from "date-fns/locale"
import type { DateRange } from "react-day-picker"
import { enUS as rdpEnUS, ptBR as rdpPtBR } from "react-day-picker/locale"
import type { AnalyticsRange } from "@shared/analytics"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { useAnalyticsStore } from "@/src/stores/analytics-store"

type PresetRange = "total" | "30d" | "7d" | "today"
const RANGE_ORDER: PresetRange[] = ["total", "30d", "7d", "today"]

/**
 * The period of the Usage page — it lives in the page header (App.tsx), not in the page
 * body, so it stays in sight while the sections scroll.
 */
export function UsageRangeControls() {
  const { t, i18n } = useTranslation()
  const range = useAnalyticsStore((s) => s.range)
  const activeDays = useAnalyticsStore((s) => s.data?.activeDays)
  const setRange = useAnalyticsStore((s) => s.setRange)
  const [customOpen, setCustomOpen] = useState(false)
  const [customDraft, setCustomDraft] = useState<DateRange | undefined>()

  const isPt = i18n.language?.startsWith("pt") ?? true
  const rangeIsCustom = typeof range === "object" && range.type === "custom"

  const customLabel = useMemo(() => {
    if (!rangeIsCustom) return t("analytics.ranges.custom")
    const locale = isPt ? dfPtBR : enUS
    return `${format(new Date(range.from), "dd MMM", { locale })} – ${format(new Date(range.to), "dd MMM", { locale })}`
  }, [rangeIsCustom, range, t, isPt])

  const handleRangeSelect = (next?: DateRange) => {
    setCustomDraft(next)
    if (!next?.from || !next.to) return
    const from = new Date(next.from)
    from.setHours(0, 0, 0, 0)
    const to = new Date(next.to)
    to.setHours(23, 59, 59, 999)
    setRange({ type: "custom", from: from.getTime(), to: to.getTime() })
    setCustomOpen(false)
  }

  return (
    <div className="flex shrink-0 items-center gap-3">
      {activeDays !== undefined && (
        <span className="hidden text-xs text-muted-foreground @3xl:inline">{t("usage.header", { active: activeDays })}</span>
      )}
      <SegmentedControl<PresetRange>
        size="sm"
        value={(typeof range === "string" ? range : RANGE_ORDER[0]) as PresetRange}
        onChange={(v) => setRange(v as AnalyticsRange)}
        options={RANGE_ORDER.map((r) => ({ value: r, label: t(`analytics.ranges.${r}`) }))}
      />
      <Popover
        open={customOpen}
        onOpenChange={(open) => {
          setCustomOpen(open)
          if (open) setCustomDraft(rangeIsCustom ? { from: new Date(range.from), to: new Date(range.to) } : undefined)
        }}
      >
        <PopoverTrigger
          render={
            <Button size="sm" variant={rangeIsCustom ? "secondary" : "outline"} className="h-7 shrink-0 gap-1 px-2">
              <CalendarIcon className="size-3" />
              <span className="text-[11px]">{customLabel}</span>
            </Button>
          }
        />
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="range"
            selected={customDraft}
            onSelect={handleRangeSelect}
            defaultMonth={customDraft?.from ?? new Date()}
            numberOfMonths={2}
            locale={isPt ? rdpPtBR : rdpEnUS}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
