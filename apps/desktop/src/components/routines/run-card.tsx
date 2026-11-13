import { useTranslation } from "react-i18next"
import { Loader2, XIcon } from "lucide-react"
import type { RoutineRunPart } from "@shared/chat"
import { usePanelStore } from "@/src/stores/panel-store"
import { useRoutinesStore } from "@/src/stores/routines-store"

/**
 * One execution of a routine inside the routine's chat.
 *
 * The execution is a MESSAGE: the answer is the text of the message and the footer carries its
 * time, duration, cost and team. This part only draws what a message cannot — that it is still
 * running, or that it failed. When it went well, it draws nothing at all.
 */

function duration(from: number, to: number): string {
  const seconds = Math.max(1, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

export function RoutineRunCard({ part, solo }: {
  part: RoutineRunPart
  /** The message has no answer text: the execution's summary is the only thing left to show. */
  solo?: boolean
}) {
  const { t, i18n } = useTranslation()
  // The message is written when the execution starts; the run itself keeps the live state.
  const live = useRoutinesStore((s) => s.runs.find((r) => r.sessionId === part.sessionId))
  const openChatTab = usePanelStore((s) => s.openChatTab)
  const status = live?.status ?? part.status
  const startedAt = live?.startedAt ?? part.startedAt

  if (status === "running") {
    return (
      <div className="flex items-center gap-2 py-0.5 text-[11.5px] text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span>{t("routines.card.workingFor", { time: duration(startedAt, Date.now()) })}</span>
      </div>
    )
  }

  if (status === "error") {
    const open = () =>
      openChatTab(
        part.sessionId,
        `${t("routines.card.execution")} ${new Date(startedAt).toLocaleTimeString(i18n.language, {
          hour: "2-digit",
          minute: "2-digit",
        })}`,
      )
    return (
      <div className="flex flex-col gap-1 py-0.5">
        <div className="flex items-start gap-2 text-[12px] leading-relaxed text-destructive">
          <XIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{part.error ?? t("routines.card.status.error")}</span>
        </div>
        <button
          type="button"
          onClick={open}
          className="self-start text-[10.5px] text-muted-foreground hover:text-foreground hover:underline"
        >
          {t("routines.card.details")}
        </button>
      </div>
    )
  }

  // It ended well: the answer IS the message, and the part leaves no trace on screen.
  if (!solo) return null
  return (
    <div className="py-0.5">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {part.summary ?? t("routines.card.noAnswer")}
      </p>
    </div>
  )
}
