import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArchiveIcon, Loader2 } from "lucide-react"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Offer shown when someone opens the single chat of a routine that has been
 * compacted enough times for the next summary to be a summary of a summary
 * (`routineChatIsFull`). The chat has no ceiling on executions — this is the
 * moment to hand the routine a fresh chat instead of letting it blur.
 *
 * "New chat" asks the main process to rotate: it opens the routine's next chat
 * (seeded with a brief of this one) and archives this one. The routine keeps
 * firing either way — ignored, the card does nothing and the chat goes on.
 */
export function RoutineChatFullCard({
  routineId,
  summaries,
}: {
  routineId: string
  /** Compactions already done in this chat */
  summaries: number
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  // The routines store is filled by the routines screen; arriving straight in
  // the chat it may still be empty, and the card needs `chatSessionId` to know
  // whether THIS is the routine's current chat.
  useEffect(() => {
    const store = useRoutinesStore.getState()
    if (!store.loaded) void store.load()
  }, [])

  if (dismissed) return null

  const rotate = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const newId = await useRoutinesStore.getState().rotateChat(routineId)
      if (!newId) {
        setFailed(true)
        return
      }
      const child = useSessionStore.getState().sessions.find((s) => s.id === newId)
      if (child) await useSessionStore.getState().selectSession(child.mode, child.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-start gap-2">
        <ArchiveIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("chat.routineChatFull.title")}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t("chat.routineChatFull.body", { count: summaries })}
          </p>
          {failed && <p className="mt-1 text-xs text-destructive">{t("chat.routineChatFull.failed")}</p>}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <button
          type="button"
          disabled={busy}
          onClick={() => void rotate()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {t("chat.routineChatFull.newChat")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setDismissed(true)}
          className="inline-flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-foreground/5 disabled:opacity-50"
        >
          {t("chat.routineChatFull.keep")}
        </button>
        <span className="text-[11px] text-muted-foreground">{t("chat.routineChatFull.hint")}</span>
      </div>
    </div>
  )
}
