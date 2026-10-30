import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUpIcon, MonitorIcon, SquareIcon } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import type { ComputerActivity } from "@shared/computer"
import { CompactInput } from "@/src/components/compact-input"
import { ComputerShotThumb } from "@/src/components/computer-thumb"
import { ActionsFeed, FullscreenChatFeed } from "@/src/components/fullscreen-dock"
import { describeAction } from "@/src/lib/computer-actions"
import { chatApi, computerApi } from "@/src/lib/ipc"
import { startChatMirror, useSessionStore } from "@/src/stores/session-store"
import { Hint } from "@/components/ui/hint"

/**
 * Floating panels of Computer Use, in the transparent window that covers the screen
 * while Orbit is out of focus: the conversation on the left edge and the agent's
 * actions on the right — collapsed handles that open on hover, as in the browser
 * fullscreen.
 *
 * The window lets the mouse through; each panel tells the main process when the mouse enters
 * or leaves it, and only then does the window capture clicks.
 */

/** Enables click capture while the mouse is over some panel. */
function useInteractive() {
  const inside = useRef(new Set<string>())
  return useCallback((key: string, over: boolean) => {
    const before = inside.current.size > 0
    if (over) inside.current.add(key)
    else inside.current.delete(key)
    const after = inside.current.size > 0
    if (before !== after) window.ipcRenderer?.send("computer-panels:interactive", after)
  }, [])
}

export function ComputerPanels({ initialSessionId }: { initialSessionId: string | null }) {
  const { t } = useTranslation()
  const [sessionId, setSessionId] = useState(initialSessionId)
  const [activity, setActivity] = useState<ComputerActivity | null>(null)
  const [chatPinned, setChatPinned] = useState(false)
  const [actionsPinned, setActionsPinned] = useState(false)
  const setInteractive = useInteractive()
  const app = activity?.sessionId === sessionId ? activity.app : null

  // Passive mirror of the chat events + the session the main process indicates.
  useEffect(() => {
    startChatMirror()
    if (!window.ipcRenderer) return
    const wrapper = window.ipcRenderer.on("computer-panels:session", (id) => setSessionId(id as string))
    const off = computerApi.onEvent((event) => {
      if (event.type === "active") setActivity(event.activity)
    })
    void computerApi.activity().then((list) => {
      const latest = [...list].sort((a, b) => b.lastAt - a.lastAt)[0]
      if (latest) setActivity(latest)
    })
    return () => {
      window.ipcRenderer.off("computer-panels:session", wrapper)
      off()
    }
  }, [])

  // History + pending requests from disk, and the status of the turn in progress
  // (the mirror only sees the events from now on).
  useEffect(() => {
    if (!sessionId) return
    void useSessionStore.getState().ensureMessages(sessionId)
    void chatApi.running().then((ids) => {
      if (!ids.includes(sessionId)) return
      useSessionStore.setState((state) => ({ status: { ...state.status, [sessionId]: state.status[sessionId] ?? "streaming" } }))
    })
  }, [sessionId])

  if (!sessionId) return null
  return (
    <div className="pointer-events-none fixed inset-0">
      <FullscreenChatFeed
        sessionId={sessionId}
        pinned={chatPinned}
        onTogglePin={() => setChatPinned((v) => !v)}
        onHoverChange={(over) => setInteractive("chat", over)}
        footer={<PanelReply sessionId={sessionId} />}
      />
      <ActionsFeed
        sessionId={sessionId}
        pinned={actionsPinned}
        onTogglePin={() => setActionsPinned((v) => !v)}
        onHoverChange={(over) => setInteractive("actions", over)}
        icon={MonitorIcon}
        title={app ? t("computer.chip.controlling", { app }) : t("computer.panels.actions")}
        filter={isComputerTool}
        describe={(part) => describeAction(part, t)}
        top={<ComputerShotThumb sessionId={sessionId} />}
        headerExtra={
          <Hint label={t("computer.chip.stopTitle")}>
            <button
              type="button"
              onClick={() => void computerApi.stop(sessionId)}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
       
               <SquareIcon className="size-2.5 fill-current" />
            {t("computer.chip.stop")}
          </button>
          </Hint>
        }
      />
    </div>
  )
}

const isComputerTool = (part: ToolPart) => part.tool.startsWith("cu_") || part.tool === "computer_task"

/**
 * Talk to the conversation that is controlling without going back to Orbit: the same field
 * as the shortcut. The message enters the queue of the conversation, with the options of its last
 * send, and leaves when the current step ends — to change course NOW, the
 * Stop of the actions is still there.
 */
function PanelReply({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const [text, setText] = useState("")
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const send = (value: string) => {
    const body = value.trim()
    if (!body) return false
    setFailed(false)
    void computerApi.reply(sessionId, body).then((ok) => {
      if (!ok) {
        setFailed(true)
        setText(body)
      }
    })
    return true
  }
  return (
    <div className="flex flex-col gap-1">
      <CompactInput
        value={text}
        onChange={setText}
        onSubmit={send}
        ref={inputRef}
        onFocusChange={(focused) => {
          window.ipcRenderer?.send("computer-panels:keyboard", focused)
          // The click arrives before the window accepts focus: the field is focused
          // again as soon as it does.
          if (focused && document.activeElement !== inputRef.current) requestAnimationFrame(() => inputRef.current?.focus())
        }}
        placeholder={t("computer.panels.replyPlaceholder")}
        trailing={
          <Hint label={t("computer.panels.replySend")}>
            <button
              type="button"
              onClick={() => {
                if (send(text)) setText("")
              }}
              aria-label={t("computer.panels.replySend")}

              className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          </Hint>
        }
      />
      {failed && <p className="text-[11px] text-destructive">{t("computer.panels.replyFailed")}</p>}
    </div>
  )
}
