import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarIcon, Clock, Cpu, FolderKanban, LayoutDashboard, MessagesSquare, Waves } from "lucide-react"
import { format } from "date-fns"
import { enUS, ptBR as dfPtBR } from "date-fns/locale"
import type { DateRange } from "react-day-picker"
import { enUS as rdpEnUS, ptBR as rdpPtBR } from "react-day-picker/locale"
import type { AnalyticsRange } from "@shared/analytics"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { cn } from "@/lib/utils"
import { useAnalyticsStore } from "@/src/stores/analytics-store"
import { ModelsTab } from "./models-tab"
import { OverviewTab } from "./overview-tab"
import { ProjectsTab } from "./projects-tab"
import { RhythmTab } from "./rhythm-tab"
import { SessionsTab } from "./sessions-tab"
import type { UsageSection } from "./usage-utils"

type PresetRange = "total" | "30d" | "7d" | "today"
const RANGE_ORDER: PresetRange[] = ["total", "30d", "7d", "today"]

/**
 * Usage page: the period on top and the sections on the right, the same shape as the Tools
 * page. The overview is the summary of everything; each other section opens the same numbers
 * in detail (models, projects with their history, every conversation, rhythm).
 */
export function UsageView() {
  const { t, i18n } = useTranslation()
  const { data, range, loading, load, setRange } = useAnalyticsStore()
  const [section, setSection] = useState<UsageSection>("overview")
  const [customOpen, setCustomOpen] = useState(false)
  const [customDraft, setCustomDraft] = useState<DateRange | undefined>()

  const isPt = i18n.language?.startsWith("pt") ?? true
  const rangeIsCustom = typeof range === "object" && range.type === "custom"

  useEffect(() => {
    void load()
  }, [load])

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

  const nav: { id: UsageSection; label: string; icon: React.ComponentType<{ className?: string }>; count?: number | string }[] = [
    { id: "overview", label: t("usage.nav.overview"), icon: LayoutDashboard },
    { id: "models", label: t("usage.nav.models"), icon: Cpu, count: data?.byModel.length },
    { id: "projects", label: t("usage.nav.projects"), icon: FolderKanban, count: data?.byProject.length },
    { id: "sessions", label: t("usage.nav.sessions"), icon: MessagesSquare, count: data?.totalSessions },
    { id: "rhythm", label: t("usage.nav.rhythm"), icon: Waves },
  ]

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t("analytics.title")}</p>
          {data && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" />
              {t("usage.header", { active: data.activeDays })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
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
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-2">
          {loading && !data ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">{t("analytics.loading")}</div>
          ) : data ? (
            <>
              {section === "overview" && <OverviewTab data={data} onNavigate={setSection} />}
              {section === "models" && <ModelsTab data={data} />}
              {section === "projects" && <ProjectsTab data={data} range={range} />}
              {section === "sessions" && <SessionsTab data={data} />}
              {section === "rhythm" && <RhythmTab data={data} />}
            </>
          ) : null}
        </div>

        <nav aria-label={t("usage.nav.label")} className="flex w-52 shrink-0 flex-col gap-0.5 border-l pl-3">
          {nav.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                section === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {count !== undefined && <span className="text-[11px] font-normal text-muted-foreground">{count}</span>}
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}
