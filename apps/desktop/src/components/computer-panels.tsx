import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { MonitorIcon, SquareIcon } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import type { ComputerActivity } from "@shared/computer"
import { ActionsFeed, FullscreenChatFeed } from "@/src/components/fullscreen-dock"
import { describeAction } from "@/src/lib/computer-actions"
import { chatApi, computerApi } from "@/src/lib/ipc"
import { startChatMirror, useSessionStore } from "@/src/stores/session-store"

/**
 * Painéis flutuantes do Computer Use, na janela transparente que cobre a tela
 * enquanto o Orbit está fora de foco: a conversa na borda esquerda e as ações
 * do agente na direita — alças recolhidas que abrem no hover, como na tela
 * cheia do navegador.
 *
 * A janela deixa o mouse passar; cada painel avisa o main quando o mouse entra
 * ou sai dele, e só então a janela captura cliques.
 */

/** Liga a captura de clique enquanto o mouse está sobre algum painel. */
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

  // Espelho passivo dos eventos do chat + a sessão que o main indicar.
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

  // Histórico + pedidos pendentes do disco, e o status do turno em andamento
  // (o espelho só vê os eventos de agora em diante).
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
        headerExtra={
          <button
            type="button"
            title={t("computer.chip.stopTitle")}
            onClick={() => void computerApi.stop(sessionId)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
          >
            <SquareIcon className="size-2.5 fill-current" />
            {t("computer.chip.stop")}
          </button>
        }
      />
    </div>
  )
}

const isComputerTool = (part: ToolPart) => part.tool.startsWith("cu_")
