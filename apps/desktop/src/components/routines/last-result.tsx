import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, CircleXIcon, Loader2 } from "lucide-react"
import type { RoutineRun } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { formatDuration, formatWhen } from "@/src/lib/format"
import { messageText } from "@/src/lib/message-utils"
import { usePeersStore } from "@/src/stores/peers-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useOpenRun } from "./use-open-run"

/**
 * The answer of the newest execution, which is what the person opens a routine to read: the
 * last assistant message of its session, with the way into the whole conversation. A failed
 * run shows its error instead, a running one says so.
 */
export function LastResult({ run }: { run: RoutineRun | null }) {
  const { t, i18n } = useTranslation()
  const sessionId = run?.sessionId
  const ensureMessages = useSessionStore((s) => s.ensureMessages)
  const remote = usePeersStore((s) => s.env !== "local")
  const loadRemote = usePeersStore((s) => s.loadMessages)
  // The newest answer of a run: from this machine's store, or from the other desktop's chat.
  const answer = useSessionStore((s) => {
    const messages = sessionId ? s.messages[sessionId] : undefined
    const last = messages ? [...messages].reverse().find((m) => m.role === "assistant") : undefined
    return last ? messageText(last).trim() : ""
  })
  const remoteAnswer = usePeersStore((s) => {
    const messages = sessionId ? s.messages[sessionId] : undefined
    const last = messages ? [...messages].reverse().find((m) => m.role === "assistant") : undefined
    return last ? messageText(last).trim() : ""
  })
  const shown = remote ? remoteAnswer : answer
  const openRun = useOpenRun()

  useEffect(() => {
    if (!sessionId) return
    if (remote) void loadRemote(sessionId)
    else void ensureMessages(sessionId)
  }, [sessionId, remote, ensureMessages, loadRemote])

  if (!run) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-5 text-center text-xs text-muted-foreground">
        {t("routines.runs.empty")}
      </div>
    )
  }

  const Icon = run.status === "running" ? Loader2 : run.status === "error" ? CircleXIcon : CheckIcon
  const facts = [
    formatWhen(run.startedAt, i18n.language),
    run.tokens > 0 ? t("routines.runs.tokens", { value: run.tokens.toLocaleString(i18n.language) }) : null,
    run.completedAt ? formatDuration(run.completedAt - run.startedAt) : null,
  ].filter(Boolean)

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Icon
          className={
            run.status === "running"
              ? "size-3.5 animate-spin text-blue-500"
              : run.status === "error"
                ? "size-3.5 text-destructive"
                : "size-3.5 text-emerald-600"
          }
        />
        <span className="text-[13px] font-medium">{t("routines.detail.lastRun")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{facts.join(" · ")}</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => openRun(run.sessionId)}>
          {t("routines.detail.openAsChat")}
        </Button>
      </div>
      <div className="max-h-72 overflow-y-auto px-4 py-3 text-xs leading-relaxed">
        {run.status === "error" ? (
          <p className="whitespace-pre-wrap break-words text-destructive">{run.error || t("routines.runs.error")}</p>
        ) : run.status === "running" ? (
          <p className="text-muted-foreground">{t("routines.runs.running")}</p>
        ) : shown ? (
          <p className="whitespace-pre-wrap break-words text-foreground/90">{shown}</p>
        ) : (
          <p className="text-muted-foreground">{t("routines.detail.noAnswer")}</p>
        )}
      </div>
    </div>
  )
}
