import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Code2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  WifiOff,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { FolderInfo, SessionInfo } from "@shared/chat"
import { parseRemoteSessionId, remoteSessionId } from "@shared/peers"
import { peersApi } from "@/src/lib/ipc"
import { EMPTY_LIST, isRemoteRunning, usePeersStore } from "@/src/stores/peers-store"
import { useWorkspaceMode } from "@/lib/workspace-context"

/**
 * The chats of the desktop picked in the environment selector — the same shape
 * as the local history: pinned, folders, recent and archived, with the actions
 * the peer granted (full control = the phone's CRUD).
 */
export function RemoteSessionList({ peerId }: { peerId: string }) {
  const { t } = useTranslation()
  const mode = useWorkspaceMode()
  const peer = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === peerId))
  const sessions = usePeersStore((s) => s.sessionsByPeer[peerId] ?? EMPTY_LIST)
  const folders = usePeersStore((s) => s.foldersByPeer[peerId] ?? EMPTY_LIST) as FolderInfo[]
  const statuses = usePeersStore((s) => s.statuses)
  const activeId = usePeersStore((s) => s.activeByPeer[peerId] ?? null)
  const openSession = usePeersStore((s) => s.openSession)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const name = peer?.name ?? ""
  const online = !!peer?.online
  const control = peer?.grants.control === true
  // Offline, the cached list stays visible (reading it is free); the actions
  // wait for the connection.
  const canAct = control && online

  const remoteId = (id: string) => parseRemoteSessionId(id)?.sessionId ?? id
  const request = <T,>(payload: { type: string; [key: string]: unknown }) =>
    peersApi.request<T>(peerId, payload)

  const createChat = async () => {
    const created = await request<SessionInfo>({ type: "sessions:create", mode })
    if (created?.id) openSession(remoteSessionId(peerId, created.id))
  }

  const rename = async (session: SessionInfo) => {
    const title = window.prompt(t("peers.remote.renamePrompt"), session.title)
    if (!title?.trim()) return
    await request({ type: "sessions:rename", sessionId: remoteId(session.id), title: title.trim() })
  }
  const togglePin = (session: SessionInfo) =>
    request({ type: "sessions:pin", sessionId: remoteId(session.id), pinned: !session.pinned })
  const toggleArchive = (session: SessionInfo) =>
    request({ type: "sessions:archive", sessionId: remoteId(session.id), archived: !session.archived })
  const remove = async (session: SessionInfo) => {
    if (!window.confirm(t("peers.remote.deleteConfirm", { title: session.title || "…", name }))) return
    await request({ type: "sessions:delete", sessionId: remoteId(session.id) })
  }

  const byDate = (a: SessionInfo, b: SessionInfo) => b.updatedAt - a.updatedAt
  const inMode = (sessions as SessionInfo[]).filter((s) => s.mode === mode)
  const live = inMode.filter((s) => !s.archived)
  const archived = inMode.filter((s) => s.archived).sort(byDate)
  const folderIds = new Set(folders.map((f) => f.id))
  const pinned = live.filter((s) => s.pinned && (!s.folderId || !folderIds.has(s.folderId))).sort(byDate)
  const loose = live.filter((s) => !s.pinned && (!s.folderId || !folderIds.has(s.folderId))).sort(byDate)
  const groups = folders
    .filter((f) => f.mode === mode && !f.archived)
    .map((folder) => ({ folder, sessions: live.filter((s) => s.folderId === folder.id).sort(byDate) }))
    .filter((g) => g.sessions.length > 0)
    .sort((a, b) => Number(!!b.folder.pinned) - Number(!!a.folder.pinned) || a.folder.name.localeCompare(b.folder.name))

  const row = (session: SessionInfo) => {
    const running = isRemoteRunning(statuses[session.id])
    const Icon = session.mode === "code" ? Code2 : MessageSquare
    return (
      <div
        key={session.id}
        className={cn(
          "group flex w-full items-center rounded-md hover:bg-sidebar-accent",
          activeId === session.id && "bg-sidebar-accent font-medium",
        )}
      >
        <button
          type="button"
          onClick={() => openSession(session.id)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs"
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{session.title || "…"}</span>
          {running ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden /> : null}
        </button>
        {canAct ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("peers.remote.actions")}
              className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background/60 group-hover:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void rename(session)} className="gap-2 text-xs">
                <Pencil className="size-3.5" />
                {t("peers.remote.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void togglePin(session)} className="gap-2 text-xs">
                {session.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {t(session.pinned ? "peers.remote.unpin" : "peers.remote.pin")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void toggleArchive(session)} className="gap-2 text-xs">
                {session.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                {t(session.archived ? "peers.remote.unarchive" : "peers.remote.archive")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void remove(session)} className="gap-2 text-xs text-destructive">
                <Trash2 className="size-3.5" />
                {t("peers.remote.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    )
  }

  const isEmpty = pinned.length === 0 && loose.length === 0 && groups.length === 0 && archived.length === 0

  return (
    <div className="flex min-w-0 flex-col px-2 pb-2">
      {!online ? (
        <div className="mx-0 mb-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
          <WifiOff className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t("peers.env.offline", { name })}
            {peer?.error ? ` ${t(`peers.error_${peer.error}`)}` : null}
          </span>
        </div>
      ) : null}
      {canAct ? (
        <Button
          variant="ghost"
          onClick={() => void createChat()}
          className="mb-1 w-full justify-start gap-2 rounded-sm p-2 text-xs font-normal text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
          {t("peers.remote.newChat")}
        </Button>
      ) : online && !control ? (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("peers.remote.readOnly", { name })}</p>
      ) : null}

      {isEmpty ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("peers.remote.empty", { name })}</p>
      ) : null}

      {pinned.length ? (
        <>
          <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{t("peers.remote.sessions")}</p>
          {pinned.map(row)}
        </>
      ) : null}

      {groups.map((g) => (
        <div key={g.folder.id} className="pt-1">
          <p className="flex items-center gap-1 px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
            {g.folder.name}
          </p>
          {g.sessions.map(row)}
        </div>
      ))}

      {loose.length ? (
        <>
          <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{t("peers.remote.recent")}</p>
          {loose.map(row)}
        </>
      ) : null}

      {archived.length ? (
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setArchivedOpen((v) => !v)}
            className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {archivedOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t("peers.remote.archived")}
            <span className="ml-auto tabular-nums">{archived.length}</span>
          </button>
          {archivedOpen ? archived.map(row) : null}
        </div>
      ) : null}
    </div>
  )
}
