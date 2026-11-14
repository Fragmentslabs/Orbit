import { useTranslation } from "react-i18next"
import { RemoteChatView } from "@/src/components/peers/remote-chat-view"
import { RemoteFiles } from "@/src/components/peers/remote-files"
import { sessionIcon } from "@/src/components/agent-meta"
import { useEnvSessions } from "@/src/hooks/use-env-sessions"
import { usePeersStore } from "@/src/stores/peers-store"
import { canBrowseRemoteFiles } from "./tab-availability"

// Panel tabs of a chat on ANOTHER desktop. They go through the peers connection only.

function usePeer() {
  return usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === s.env))
}

/** A conversation of the paired desktop, opened in a tab. */
export function RemoteChatTab({ sessionId, onPick }: { sessionId?: string; onPick: (sessionId: string) => void }) {
  if (!sessionId) return <RemoteChatPicker onPick={onPick} />
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-2 pb-4" style={{ "--panel-bg": "var(--sidebar)" } as React.CSSProperties}>
      <RemoteChatView sessionId={sessionId} />
    </div>
  )
}

/** The "new chat" tab on a paired desktop: chats belong to that machine, so one picks an existing one. */
function RemoteChatPicker({ onPick }: { onPick: (sessionId: string) => void }) {
  const { t } = useTranslation()
  const peer = usePeer()
  const sessions = useEnvSessions().filter((s) => !s.archived && !s.parentId)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
      <p className="text-sm font-medium">{t("peers.remote.pickChat", { name: peer?.name ?? "" })}</p>
      {sessions.length === 0 ? <p className="text-xs text-muted-foreground">{t("peers.remote.noChats", { name: peer?.name ?? "" })}</p> : null}
      {sessions.slice(0, 50).map((session) => {
        const Icon = sessionIcon(session)
        return (
          <button
            key={session.id}
            type="button"
            onClick={() => onPick(session.id)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent"
          >
            {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{session.title}</span>
          </button>
        )
      })}
    </div>
  )
}

/** The project files of the chat on screen, read through the peer's "files" grant. */
export function RemoteFilesTab({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const peer = usePeer()
  const name = peer?.name ?? ""
  if (!sessionId) return <Note text={t("peers.remote.filesNeedChat")} />
  if (!canBrowseRemoteFiles(peer)) return <Note text={t("peers.remote.filesNotAllowed", { name })} />
  return <RemoteFiles embedded sessionId={sessionId} peerName={name} onClose={() => {}} />
}

function Note({ text }: { text: string }) {
  return <p className="p-6 text-center text-xs text-muted-foreground">{text}</p>
}
