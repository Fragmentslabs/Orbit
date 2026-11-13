import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import type { Routine } from "@shared/routines"
import { ChatView } from "@/src/components/chat-view"
import { useStacked } from "@/src/hooks/use-stacked"
import { routinesApi } from "@/src/lib/ipc"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useSessionStore } from "@/src/stores/session-store"
import { RoutineDetailsPanel } from "./routine-details-panel"
import { RoutineEmptyState } from "./routine-empty-state"

/** The panel needs its own column: below this the chat gets too narrow and it goes over it. */
const PANEL_COLUMN_PX = 880

/**
 * The routine, opened: its chat takes the screen and the information lives in the panel beside
 * it — the same pattern as a fragment's details (the info button in the window header opens it).
 *
 * The conversation is the routine's OWN chat (created on first use): every execution shows up
 * in it AS A MESSAGE — the answer is read there, marked by its date —, and what the person types
 * here is another message of the same chat. The runs still happen in sessions of their own; the
 * panel only points at them (and at the day of each one).
 */
export function RoutineScreen({ routine }: { routine: Routine }) {
  const { t } = useTranslation()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [chatId, setChatId] = useState<string | null>(null)
  const detailsOpen = useRoutinesStore((s) => s.detailsOpen)
  const stacked = useStacked(root, PANEL_COLUMN_PX)
  const sessions = useSessionStore((s) => s.sessions)
  const update = useRoutinesStore((s) => s.update)
  const runs = useRoutinesStore((s) => s.runs)
  const chatModel = useSessionModelPrefs((s) => (chatId ? s.overrides[chatId] : undefined))

  // The chat is born in the main process; the screen only asks for its id.
  useEffect(() => {
    let alive = true
    setChatId(null)
    routinesApi
      .chatSession(routine.id)
      .then((session) => {
        if (alive) setChatId(session?.id ?? null)
      })
      .catch(() => {
        if (alive) setChatId(null)
      })
    return () => {
      alive = false
    }
  }, [routine.id])

  // The routine's chat IS the routine: the model chosen in its composer is the routine's model.
  // Opening the chat pins the composer to the routine's model, so the two never disagree.
  useEffect(() => {
    if (!chatId) return
    const { overrides, selectModel } = useSessionModelPrefs.getState()
    const saved = overrides[chatId]
    if (saved?.providerId === routine.model.providerId && saved?.modelId === routine.model.modelId) return
    selectModel(chatId, routine.model.providerId, routine.model.modelId)
  }, [chatId, routine.model.providerId, routine.model.modelId])

  // ...and a model picked in the composer becomes the routine's model: the next executions use
  // it. Reads the store's current value so the seed above never feeds this back.
  useEffect(() => {
    if (!chatId) return
    const current = useSessionModelPrefs.getState().overrides[chatId]
    if (!current) return
    if (current.providerId === routine.model.providerId && current.modelId === routine.model.modelId) return
    void update(routine.id, { model: current })
  }, [chatId, chatModel, routine.id, routine.model.providerId, routine.model.modelId, update])

  // Opening the routine is reading it: the executions' unread counts — the ones that keep an
  // inactive routine listed in the sidebar — go with it, as they would in any conversation.
  useEffect(() => {
    if (!chatId) return
    const ids = [
      chatId,
      ...runs.filter((run) => run.routineId === routine.id).map((run) => run.sessionId),
    ]
    useSessionStore.getState().clearUnread(ids)
  }, [chatId, routine.id, runs])

  const session = chatId ? sessions.find((s) => s.id === chatId) : undefined

  return (
    <div ref={setRoot} className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {session ? (
          <ChatView
            sessionId={session.id}
            embedded
            startScreen={<RoutineEmptyState routine={routine} />}
            hideFolders
            hideInitCard
            dateSeparator="line"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="sr-only">{t("routines.loading")}</span>
          </div>
        )}
      </div>
      {detailsOpen && <RoutineDetailsPanel routine={routine} overlaid={stacked} />}
    </div>
  )
}
