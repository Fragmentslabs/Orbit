import { useTranslation } from "react-i18next"
import { AlignLeft, Bot, BrainCircuit, Eye, FileText, Globe, Network, RefreshCw, Search } from "lucide-react"
import type { PermissionMode } from "@shared/chat"
import type { RoutineModes, Schedule } from "@shared/routines"
import { DEFAULT_ROUTINE_PERMISSION, parseTime, ROUTINE_MODES, ROUTINE_PERMISSIONS } from "@shared/routines"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import { describeSchedule, scheduleMode, shortDays, type ScheduleMode } from "./schedule"

import { Hint } from "@/components/ui/hint"
/**
 * Schedule and mode editing — shared by creating and editing an existing
 * routine. The schedule is structured, so the UI is presets + fine tuning, in
 * the spirit of ScheduleMessageDialog: nobody should have to write cron to say
 * "every day at 9".
 */

const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]

/** Today as "YYYY-MM-DD" (local time) — default for the "once" mode. */
function todayIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (schedule: Schedule) => void }) {
  const { t } = useTranslation()
  const mode = scheduleMode(schedule)
  const names = shortDays(t)
  const timeValid = !!parseTime(schedule.time)
  // The one-off moment already passed: the routine would be created and never run.
  const onceAt = (() => {
    if (!schedule.onceDate) return null
    const hm = parseTime(schedule.time)
    if (!hm) return null
    const date = new Date(`${schedule.onceDate}T00:00:00`)
    if (Number.isNaN(date.getTime())) return null
    date.setHours(hm.hour, hm.minute, 0, 0)
    return date.getTime()
  })()
  const oncePast = mode === "once" && onceAt !== null && onceAt <= Date.now()

  const changeMode = (next: ScheduleMode) => {
    if (next === "daily") onChange({ time: schedule.time })
    else if (next === "weekly") onChange({ time: schedule.time, days: schedule.days?.length ? schedule.days : WEEKDAYS })
    else if (next === "intervalHours") onChange({ time: schedule.time, intervalHours: schedule.intervalHours ?? 6 })
    else if (next === "once") onChange({ time: schedule.time, onceDate: schedule.onceDate ?? todayIso() })
    else onChange({ time: schedule.time, intervalDays: schedule.intervalDays ?? 2 })
  }

  const toggleDay = (day: number) => {
    const current = new Set(schedule.days ?? [])
    if (current.has(day)) current.delete(day)
    else current.add(day)
    // Never leaves the list empty: with no day marked the routine would have
    // no time to run, and the screen would show a schedule that never fires.
    const days = [...current].sort((a, b) => a - b)
    onChange({ time: schedule.time, days: days.length ? days : [day] })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["daily", "weekly", "intervalDays", "intervalHours", "once"] as ScheduleMode[]).map((op) => (
          <button
            key={op}
            type="button"
            onClick={() => changeMode(op)}
            className={cn(
              "rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
              mode === op
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
            )}
          >
            {t(`routines.schedule.mode.${op}`)}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("routines.schedule.time")}</span>
          <input
            type="text"
            value={schedule.time}
            placeholder={t("routines.timePlaceholder")}
            onChange={(e) => onChange({ ...schedule, time: e.target.value })}
            className={cn(
              "w-20 rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              timeValid ? "border-input" : "border-destructive",
            )}
          />
        </span>
      </div>

      {mode === "weekly" && (
        <div className="flex flex-wrap items-center gap-1">
          {names.map((name, day) => {
            const active = schedule.days?.includes(day) ?? false
            return (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                className={cn(
                  "size-7 rounded-md border text-[11px] font-medium transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
              >
                {name}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => onChange({ time: schedule.time, days: WEEKDAYS })}
            className="ml-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("routines.schedule.workdays")}
          </button>
          <button
            type="button"
            onClick={() => onChange({ time: schedule.time, days: WEEKEND })}
            className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t("routines.schedule.weekend")}
          </button>
        </div>
      )}

      {mode === "intervalDays" && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {t("routines.schedule.every")}
          <input
            type="number"
            min={2}
            max={365}
            value={schedule.intervalDays ?? 2}
            onChange={(e) =>
              onChange({
                time: schedule.time,
                intervalDays: Math.max(2, Math.min(365, Number(e.target.value) || 2)),
              })
            }
            className="w-16 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          {t("routines.schedule.days")}
        </label>
      )}

      {mode === "intervalHours" && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {t("routines.schedule.every")}
          <input
            type="number"
            min={1}
            max={23}
            value={schedule.intervalHours ?? 6}
            onChange={(e) =>
              onChange({
                time: schedule.time,
                intervalHours: Math.max(1, Math.min(23, Number(e.target.value) || 6)),
              })
            }
            className="w-16 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          {t("routines.schedule.hours")}
        </label>
      )}

      {mode === "once" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {t("routines.schedule.em")}
            <input
              type="date"
              min={todayIso()}
              value={schedule.onceDate ?? todayIso()}
              onChange={(e) => e.target.value && onChange({ time: schedule.time, onceDate: e.target.value })}
              className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </label>
          <p className={cn("text-[11px]", oncePast ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
            {t(oncePast ? "routines.schedule.pastDate" : "routines.schedule.onceHint")}
          </p>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">{describeSchedule(schedule, t)}</p>
    </div>
  )
}

// ─── Modes ───────────────────────────────────────────────────────────────────

/** Icon of each mode — the same ones as the preferences' "active modes" section. */
const MODE_ICON: Record<(typeof ROUTINE_MODES)[number], typeof Bot> = {
  brain: BrainCircuit,
  loop: RefreshCw,
  subagents: Bot,
  orchestrate: Network,
  browser: Globe,
  plan: FileText,
  simple: AlignLeft,
  search: Search,
  vision: Eye,
}

/** Editable mode keys. */
type ModeKey = (typeof ROUTINE_MODES)[number]

/**
 * Modes as clickable badges, in the same pattern as the preferences' "active
 * modes by default": on is gold (primary), off is ghost. The agent SUGGESTS
 * when creating — the user is the one who confirms, with a click.
 */
export function ModesEditor({
  modes,
  onChange,
  available = ROUTINE_MODES,
}: {
  modes: RoutineModes
  onChange: (modes: RoutineModes) => void
  /** Modes shown — empty when an agent or a team decides the abilities. */
  available?: ModeKey[]
}) {
  const { t } = useTranslation()
  const permission = modes.permissionMode ?? DEFAULT_ROUTINE_PERMISSION

  const toggle = (key: ModeKey) => {
    const on = modes[key] !== true
    const next: RoutineModes = { ...modes, [key]: on || undefined }
    // Orchestration implies loop + subagents and is incompatible with plan —
    // same rule as the chat:send handler, applied here so the screen does not
    // show a combination the backend will undo on its own.
    if (key === "orchestrate" && on) {
      next.loop = true
      next.subagents = true
      next.plan = undefined
    }
    if (key === "plan" && on) next.orchestrate = undefined
    onChange(next)
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {available.map((key) => {
          const Icon = MODE_ICON[key]
          const active = modes[key] === true
          return (
            <Hint label={t(`routines.modes.${key}.description`)}>
              <button
                key={key}
                type="button"
                onClick={() => toggle(key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
              >
                <Icon className="size-3.5" />
                {t(`routines.modes.${key}.name`)}
              </button>
            </Hint>
          )
        })}
      </div>

      <div className="space-y-1">
        <p className="text-[11px] text-muted-foreground">{t("permissions.title")}</p>
        <div className="flex flex-wrap gap-1.5">
          {ROUTINE_PERMISSIONS.map((op) => (
            <Hint label={t(`permissions.${op}Description`)}>
              <button
                key={op}
                type="button"
                onClick={() => onChange({ ...modes, permissionMode: op })}
                className={cn(
                  "rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                  permission === op
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
              >
                {t(`permissions.${op}`)}
              </button>
            </Hint>
          ))}
        </div>
        {permission === "ask" && (
          <p className="text-[11px] text-muted-foreground">{t("routines.modes.permissionWarning")}</p>
        )}
      </div>
    </div>
  )
}

/** Compact (read-only) badges of the enabled modes — card and detail. */
export function ModeBadges({
  modes,
  permission,
  available = ROUTINE_MODES,
}: {
  modes: RoutineModes
  permission?: boolean
  /** Modes taken into account — empty when an agent or a team decides the abilities. */
  available?: ModeKey[]
}) {
  const { t } = useTranslation()
  const active = available.filter((key) => modes[key] === true)
  const permissionMode: PermissionMode = modes.permissionMode ?? DEFAULT_ROUTINE_PERMISSION
  if (active.length === 0 && !permission) return null
  return (
    <span className="flex flex-wrap items-center gap-1">
      {active.map((key) => {
        const Icon = MODE_ICON[key]
        return (
          <span
            key={key}
            title={t(`routines.modes.${key}.description`)}
            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
          >
            <Icon className="size-3" />
            {t(`routines.modes.${key}.name`)}
          </span>
        )
      })}
      {permission && (
        <span
          title={t(`permissions.${permissionMode}Description`)}
          className="inline-flex items-center rounded-md border border-transparent bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {t(`permissions.${permissionMode}`)}
        </span>
      )}
    </span>
  )
}

/** Enable/disable switch reused by the card and the detail header. */
export function ActiveSwitch({ active, onChange }: { active: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <Switch
      checked={active}
      onCheckedChange={onChange}
      aria-label={active ? t("routines.list.active") : t("routines.list.paused")}
      title={active ? t("routines.list.active") : t("routines.list.paused")}
    />
  )
}
