import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarClockIcon } from "lucide-react"
import type { Routine } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useRoutinesStore } from "@/src/stores/routines-store"

/** Tomorrow, in the format the date input uses ("YYYY-MM-DD", local time). */
function tomorrow(): string {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/**
 * Rescheduling a one-off routine that already ran: one decision (the day and the time), so one
 * small dialog instead of walking through the settings panel. Confirming writes a clean one-off
 * schedule — `onceDate` + `time`, with no weekday or interval left behind — and turns the
 * routine back on.
 */
export function RescheduleDialog({
  routine,
  open,
  onOpenChange,
}: {
  routine: Routine
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const update = useRoutinesStore((s) => s.update)
  const [date, setDate] = useState("")
  const [time, setTime] = useState("09:00")
  // Read at opening time: a run arriving while the dialog is open must not reset the fields.
  const latest = useRef(routine)
  latest.current = routine

  useEffect(() => {
    if (!open) return
    setDate(tomorrow())
    setTime(latest.current.schedule.time || "09:00")
  }, [open])

  const confirm = () => {
    if (!date || !time) return
    void update(routine.id, { schedule: { onceDate: date, time }, active: true })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[380px] gap-0 p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">{t("routines.reschedule.title")}</DialogTitle>

        <header className="flex items-start gap-3 border-b px-5 py-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <CalendarClockIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">{t("routines.reschedule.title")}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{routine.title}</p>
          </div>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium">{t("routines.reschedule.date")}</span>
            <Input type="date" value={date} min={tomorrow()} onChange={(e) => setDate(e.target.value)} className="h-8" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium">{t("routines.reschedule.time")}</span>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-8" />
          </label>
        </div>

        <footer className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!date || !time} onClick={confirm}>
            {t("routines.reschedule.confirm")}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
