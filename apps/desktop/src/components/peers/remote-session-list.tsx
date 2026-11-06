import { useTranslation } from "react-i18next"
import { Code2, MessageSquare, Pin, WifiOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { EMPTY_LIST, isRemoteRunning, usePeersStore } from "@/src/stores/peers-store"

/**
 * The chats of the desktop picked in the environment selector — in place of the
 * local history. Read from that machine; pinned first, then the most recent.
 */
export function RemoteSessionList({ peerId }: { peerId: string }) {
  const { t } = useTranslation()
  const peer = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === peerId))
  const sessions = usePeersStore((s) => s.sessionsByPeer[peerId] ?? EMPTY_LIST)
  const statuses = usePeersStore((s) => s.statuses)
  const activeId = usePeersStore((s) => s.activeByPeer[peerId] ?? null)
  const openSession = usePeersStore((s) => s.openSession)
  const name = peer?.name ?? ""

  if (peer && !peer.online) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
        <WifiOff className="size-5" />
        <span>{t("peers.env.offline", { name })}</span>
        {peer.error ? <span className="text-[11px]">{t(`peers.error_${peer.error}`)}</span> : null}
      </div>
    )
  }

  const ordered = [...sessions].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
  if (ordered.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-muted-foreground">{t("peers.remote.empty", { name })}</p>
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-2">
      <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{t("peers.remote.sessions")}</p>
      {ordered.map((session) => {
        const running = isRemoteRunning(statuses[session.id])
        const Icon = session.mode === "code" ? Code2 : MessageSquare
        return (
          <button
            key={session.id}
            type="button"
            onClick={() => openSession(session.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent",
              activeId === session.id && "bg-sidebar-accent font-medium",
            )}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{session.title || "…"}</span>
            {session.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" /> : null}
            {running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden /> : null}
          </button>
        )
      })}
    </div>
  )
}
