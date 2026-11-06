import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import type { Routine } from "@shared/routines"
import { upcomingRuns } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatTime } from "@/src/lib/format"

/** Pixels per hour of the grid, and the height of one event (about 54 minutes of it). */
const HOUR_PX = 40
const EVENT_PX = 36
const EVENT_HOURS = EVENT_PX / HOUR_PX
/** The grid always covers at least these hours, and widens to fit what the week has. */
const DEFAULT_FROM = 7
const DEFAULT_TO = 19

interface AgendaEvent {
  routine: Routine
  at: number
  /** Position inside the day, in hours from midnight. */
  hour: number
  lane: number
  lanes: number
}

/** Monday 00:00 of the week that contains `date`. */
function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

/**
 * Events of one day side by side when they overlap: each cluster of events that touch in time
 * shares the width of the column, in as many lanes as the cluster needs.
 */
function layoutDay(events: Omit<AgendaEvent, "lane" | "lanes">[]): AgendaEvent[] {
  const sorted = [...events].sort((a, b) => a.hour - b.hour)
  const out: AgendaEvent[] = []
  let cluster: AgendaEvent[] = []
  let clusterEnd = -1
  let laneEnds: number[] = []

  const flush = () => {
    for (const e of cluster) e.lanes = laneEnds.length
    out.push(...cluster)
    cluster = []
    laneEnds = []
  }

  for (const e of sorted) {
    if (e.hour >= clusterEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= e.hour)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(0)
    }
    laneEnds[lane] = e.hour + EVENT_HOURS
    clusterEnd = Math.max(clusterEnd, e.hour + EVENT_HOURS)
    cluster.push({ ...e, lane, lanes: 1 })
  }
  flush()
  return out
}

/**
 * The week of the routines: Monday to Sunday by hour, each firing a block in its day. The
 * firings come from `upcomingRuns` (the scheduler's own rules); paused routines show as
 * outlines. Chat and code routines have their own color, the selected one a ring.
 */
export function RoutinesAgenda({ routines, selectedId, onSelect }: {
  routines: Routine[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [offset, setOffset] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // The "now" line moves on its own.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const week = useMemo(() => {
    const start = mondayOf(new Date(now))
    start.setDate(start.getDate() + offset * 7)
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return d
    })
    const end = new Date(start)
    end.setDate(start.getDate() + 7)
    return { start, end, days }
  }, [offset, now])

  const layout = useMemo(() => {
    const perDay: Omit<AgendaEvent, "lane" | "lanes">[][] = week.days.map(() => [])
    for (const routine of routines) {
      for (const at of upcomingRuns(routine, week.start.getTime(), week.end.getTime(), { includeInactive: true, limit: 400 })) {
        const d = new Date(at)
        const index = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - week.start.getTime()) / 86_400_000)
        if (index < 0 || index > 6) continue
        perDay[index].push({ routine, at, hour: d.getHours() + d.getMinutes() / 60 })
      }
    }
    const hours = perDay.flat().map((e) => e.hour)
    const from = Math.max(0, Math.min(DEFAULT_FROM, Math.floor(Math.min(...hours, DEFAULT_FROM))))
    const to = Math.min(24, Math.max(DEFAULT_TO, Math.ceil(Math.max(...hours, DEFAULT_TO) + EVENT_HOURS)))
    return { columns: perDay.map(layoutDay), from, to }
  }, [routines, week])

  // Changing the week starts again from the top of the grid.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [offset])

  const today = new Date(now)
  const todayIndex = week.days.findIndex(
    (d) => d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate(),
  )
  const hourCount = layout.to - layout.from
  const rangeLabel = `${week.days[0].toLocaleDateString(locale, { day: "numeric", month: "short" })} – ${week.days[6].toLocaleDateString(locale, { day: "numeric", month: "short" })}`

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button size="icon-sm" variant="ghost" aria-label={t("routines.agenda.prev")} onClick={() => setOffset((o) => o - 1)}>
          <ChevronLeftIcon className="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={t("routines.agenda.next")} onClick={() => setOffset((o) => o + 1)}>
          <ChevronRightIcon className="size-4" />
        </Button>
        <span className="ml-1 text-xs font-medium">{rangeLabel}</span>
        {offset !== 0 && (
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setOffset(0)}>
            {t("routines.agenda.today")}
          </Button>
        )}
      </div>

      <div className="grid shrink-0 grid-cols-[2.5rem_repeat(7,minmax(0,1fr))] border-b">
        <span />
        {week.days.map((d, i) => (
          <span
            key={i}
            className={cn("border-l py-1.5 text-center text-[10px] capitalize text-muted-foreground", i === todayIndex && "text-primary")}
          >
            {d.toLocaleDateString(locale, { weekday: "short" })}
            <span className="block text-[13px] font-semibold">{d.getDate()}</span>
          </span>
        ))}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-[2.5rem_repeat(7,minmax(0,1fr))]" style={{ height: hourCount * HOUR_PX }}>
          <div className="flex flex-col">
            {Array.from({ length: hourCount }, (_, i) => (
              <span
                key={i}
                className="box-border border-t pr-1.5 pt-0.5 text-right text-[9px] text-muted-foreground first:border-t-0"
                style={{ height: HOUR_PX }}
              >
                {String(layout.from + i).padStart(2, "0")}
              </span>
            ))}
          </div>
          {layout.columns.map((events, dayIndex) => (
            <div
              key={dayIndex}
              className={cn("relative border-l", dayIndex === todayIndex && "bg-primary/5")}
              style={{
                backgroundImage: "linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
                backgroundSize: `100% ${HOUR_PX}px`,
              }}
            >
              {dayIndex === todayIndex && (
                <span
                  className="absolute inset-x-0 z-10 border-t border-primary"
                  style={{ top: (today.getHours() + today.getMinutes() / 60 - layout.from) * HOUR_PX }}
                  aria-hidden
                />
              )}
              {events.map((e) => {
                const selected = e.routine.id === selectedId
                const code = e.routine.mode === "code"
                return (
                  <button
                    key={`${e.routine.id}:${e.at}`}
                    type="button"
                    onClick={() => onSelect(e.routine.id)}
                    title={`${e.routine.title} — ${formatTime(e.at, locale)}`}
                    className={cn(
                      "absolute box-border overflow-hidden rounded-md border px-1.5 py-0.5 text-left transition-colors",
                      e.routine.active
                        ? code
                          ? "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-300"
                          : "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300"
                        : "border-dashed border-muted-foreground/50 text-muted-foreground",
                      selected && "ring-2 ring-foreground",
                    )}
                    style={{
                      top: (e.hour - layout.from) * HOUR_PX + 1,
                      height: EVENT_PX - 2,
                      left: `calc(${(e.lane / e.lanes) * 100}% + 2px)`,
                      width: `calc(${100 / e.lanes}% - 4px)`,
                    }}
                  >
                    <span className="block text-[9px] opacity-80">{formatTime(e.at, locale)}</span>
                    <span className="block truncate text-[10px] font-medium">{e.routine.title}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
