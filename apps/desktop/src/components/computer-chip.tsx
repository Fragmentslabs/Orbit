import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { MonitorIcon, SquareIcon } from "lucide-react"
import type { ComputerActivity } from "@shared/computer"
import { cn } from "@/lib/utils"
import { Shimmer } from "@/src/components/ai/shimmer"
import { computerApi } from "@/src/lib/ipc"

/**
 * Chip "Controlando <app>" no header enquanto o agente desta conversa controla
 * o computador: app atual, tempo desde o início e Parar — que aborta o turno
 * inteiro (o mesmo do ⌘⇧.). Some quando o controle termina (fim do turno,
 * ociosidade ou Parar).
 */

const activity = new Map<string, ComputerActivity>()
const listeners = new Set<() => void>()
let subscribed = false

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscribed && typeof window !== "undefined" && window.ipcRenderer) {
    subscribed = true
    const notify = () => listeners.forEach((l) => l())
    // Depois de um reload do renderer, o main ainda pode estar controlando.
    void computerApi.activity().then((list) => {
      for (const item of list) activity.set(item.sessionId, item)
      notify()
    })
    computerApi.onEvent((event) => {
      if (event.type === "active") activity.set(event.activity.sessionId, event.activity)
      else activity.delete(event.sessionId)
      notify()
    })
  }
  return () => listeners.delete(listener)
}

function elapsed(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
}

export function ComputerChip({ sessionId, className }: { sessionId?: string; className?: string }) {
  const { t } = useTranslation()
  const [, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((v) => v + 1)), [])
  const entry = sessionId ? activity.get(sessionId) : undefined

  // Relógio do chip: um tique por segundo só enquanto há controle.
  useEffect(() => {
    if (!entry) return
    const timer = setInterval(() => setTick((v) => v + 1), 1_000)
    return () => clearInterval(timer)
  }, [entry])

  if (!sessionId || !entry) return null
  const label = t("computer.chip.controlling", { app: entry.app })
  return (
    <div
      title={entry.lastAction ?? label}
      className={cn(
        // Amarelo primário do Orbit; o texto fica no foreground porque amarelo
        // sobre fundo claro não se lê.
        "inline-flex max-w-full items-center gap-1.5 self-center rounded-full border border-primary/60 bg-primary/10 py-0.5 pl-2.5 pr-0.5 text-[11px] font-medium text-foreground shadow-sm backdrop-blur",
        className,
      )}
    >
      <MonitorIcon className="size-3.5 shrink-0 text-primary-foreground dark:text-primary" />
      <Shimmer className="hidden max-w-40 truncate @lg:inline-block">{label}</Shimmer>
      <span className="font-mono tabular-nums text-muted-foreground">{elapsed(entry.startedAt)}</span>
      <button
        type="button"
        title={t("computer.chip.stopTitle")}
        aria-label={t("computer.chip.stopTitle")}
        onClick={() => void computerApi.stop(sessionId)}
        className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-primary-foreground transition-colors hover:bg-primary/85"
      >
        <SquareIcon className="size-2.5 fill-current" />
        {t("computer.chip.stop")}
      </button>
    </div>
  )
}
