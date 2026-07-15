import { useEffect, useState } from "react"
import { CalendarIcon, Clock } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface SchedulePreset {
  label: string
  getTimestamp: () => number
}

const PRESETS: SchedulePreset[] = [
  { label: "Em 30 minutos", getTimestamp: () => Date.now() + 30 * 60 * 1000 },
  { label: "Em 1 hora", getTimestamp: () => Date.now() + 60 * 60 * 1000 },
  { label: "Em 2 horas", getTimestamp: () => Date.now() + 2 * 60 * 60 * 1000 },
  { label: "Amanhã às 09:00", getTimestamp: () => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }},
]

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    dateStyle: "full",
    timeStyle: "short",
  })
}

function defaultDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function defaultTime(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() + 5)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function parseCustom(date: string, time: string): number | null {
  if (!date || !time) return null
  const [y, m, d] = date.split("-").map(Number)
  const [hh, mm] = time.split(":").map(Number)
  if (isNaN(y) || isNaN(m) || isNaN(d) || isNaN(hh) || isNaN(mm)) return null
  return new Date(y, m - 1, d, hh, mm).getTime()
}

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (timestamp: number) => void
}) {
  const [customDate, setCustomDate] = useState(defaultDate())
  const [customTime, setCustomTime] = useState(defaultTime())
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setCustomDate(defaultDate())
      setCustomTime(defaultTime())
      setSelectedPreset(null)
      setPreview(null)
    }
  }, [open])

  useEffect(() => {
    if (selectedPreset !== null) return
    const ts = parseCustom(customDate, customTime)
    if (ts && ts > Date.now()) {
      setPreview(formatDate(ts))
    } else {
      setPreview(null)
    }
  }, [customDate, customTime, selectedPreset])

  const handlePreset = (preset: SchedulePreset, idx: number) => {
    const ts = preset.getTimestamp()
    setSelectedPreset(idx)
    setPreview(formatDate(ts))
  }

  const handleConfirm = () => {
    if (!preview) return
    let ts: number
    if (selectedPreset !== null) {
      ts = PRESETS[selectedPreset].getTimestamp()
    } else {
      const parsed = parseCustom(customDate, customTime)
      if (!parsed || parsed <= Date.now()) return
      ts = parsed
    }
    onConfirm(ts)
    onOpenChange(false)
  }

  const canConfirm = preview !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <CalendarIcon className="size-4" />
            Agendar mensagem
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Escolha um horário</span>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((preset, idx) => (
                <Button
                  key={preset.label}
                  variant={selectedPreset === idx ? "default" : "outline"}
                  size="sm"
                  className="text-xs"
                  onClick={() => handlePreset(preset, idx)}
                >
                  <Clock className="size-3 mr-1" />
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">Ou defina data/hora</span>
            <div className="flex gap-2">
              <input
                type="text"
                value={customDate}
                placeholder="AAAA-MM-DD"
                onChange={(e) => {
                  setCustomDate(e.target.value)
                  setSelectedPreset(null)
                }}
                onFocus={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono"
              />
              <input
                type="text"
                value={customTime}
                placeholder="HH:MM"
                onChange={(e) => {
                  setCustomTime(e.target.value)
                  setSelectedPreset(null)
                }}
                onFocus={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className="w-20 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono"
              />
            </div>
          </div>

          {preview && (
            <p className="text-xs text-muted-foreground text-center">
              Enviará em <span className="font-medium text-foreground">{preview}</span>
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button size="sm" disabled={!canConfirm} onClick={handleConfirm}>
            Confirmar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
