import { useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Folder, FolderOpen, Lock, WifiOff } from "lucide-react"
import type { SessionInfo } from "@shared/chat"
import { showsPersonaOnWelcome } from "@shared/appearance"
import { remoteSessionId } from "@shared/peers"
import { pickWelcomeTitle } from "@shared/welcome-title"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useWorkspaceMode } from "@/lib/workspace-context"
import { Persona } from "@/src/components/ai/persona"
import { AskCard } from "@/src/components/ask-card"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { peersApi } from "@/src/lib/ipc"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import { useAppSettings } from "@/src/stores/app-settings"
import { isRemoteRunning, useActiveRemoteSession, usePeersStore } from "@/src/stores/peers-store"
import { RemoteFiles } from "./remote-files"
import { RemoteFolderPicker } from "./remote-folder-picker"
import { RemoteComposer, type RemoteSubmit } from "./remote-composer"
import { RemoteMessageList } from "./remote-message-list"

/**
 * A chat of another desktop, read live over the pinned connection.
 *
 * It looks and behaves like the conversation at home: no banner announcing "remote
 * environment" (the sidebar's selector already says where you are), the same welcome
 * screen for a new chat in the mode picked in the sidebar, and a composer at the bottom.
 *
 * The messages go through the same components as a local chat, with the namespaced
 * session id — that is what makes a motion/design/slides card, an image or an audio of
 * that machine open from here (main routes the piece IPCs and the orbit-* schemes to the
 * peer). The composer is the local one's counterpart (remote-composer.tsx). What this view
 * does NOT offer is on purpose: revert and fork — those belong to the machine that runs the agent.
 *
 * `sessionId` pins a specific chat (the routine screen embeds one); without it the view
 * follows the chat picked in the sidebar, and no chat means the new-chat screen.
 */
export function RemoteChatView({ sessionId: pinned, startScreen }: {
  sessionId?: string
  /** What an empty chat shows instead of the generic greeting (a routine's own screen). */
  startScreen?: ReactNode
} = {}) {
  const { t } = useTranslation()
  const env = usePeersStore((s) => s.env)
  const peer = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === s.env))
  const active = useActiveRemoteSession()
  const sessionId = pinned ?? active?.sessionId ?? null
  const session = usePeersStore((s) => (sessionId && s.env !== "local" ? s.sessionsByPeer[s.env]?.find((x) => x.id === sessionId) : undefined))
  const messages = usePeersStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  const error = usePeersStore((s) => (sessionId ? s.errors[sessionId] : undefined))
  const status = usePeersStore((s) => (sessionId ? s.statuses[sessionId] : undefined))
  const sending = usePeersStore((s) => (sessionId ? !!s.sending[sessionId] : false))
  const waiting = usePeersStore((s) => !!s.snapshot?.running.find((r) => r.sessionId === sessionId)?.waiting)
  const asks = usePeersStore((s) => (sessionId ? s.pendingAsks[sessionId] : undefined))
  const replyAsk = usePeersStore((s) => s.replyAsk)
  const loadMessages = usePeersStore((s) => s.loadMessages)
  const send = usePeersStore((s) => s.send)
  const [filesOpen, setFilesOpen] = useState(false)

  const name = peer?.name ?? ""
  const busy = isRemoteRunning(status)
  const canSend = (!!peer?.grants.control || !!peer?.grants.send) && !!peer?.online
  const canControl = !!peer?.grants.control && !!peer?.online
  const canFiles = !!peer?.grants.files && !!peer?.online
  const mode = session?.mode === "code" ? "code" : "chat"

  useEffect(() => {
    if (sessionId) void loadMessages(sessionId)
  }, [sessionId, loadMessages])

  // Reconnected after being offline: the history may have moved on.
  useEffect(() => {
    if (sessionId && peer?.online) void loadMessages(sessionId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer?.online])

  useEffect(() => {
    setFilesOpen(false)
  }, [sessionId])

  if (env === "local") return null

  // No chat open: the new-chat screen, in the mode the sidebar is on.
  if (!sessionId) {
    return <RemoteWelcome peerId={env} name={name} canSend={canSend} online={!!peer?.online} />
  }

  const submit = async ({ text, extras }: RemoteSubmit) => {
    if (!canSend || busy || sending) return
    await send(sessionId, text, extras)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {canFiles ? (
            <Button
              variant={filesOpen ? "secondary" : "ghost"}
              size="sm"
              className="absolute right-2 top-0 z-10 h-7 gap-1.5 text-xs"
              onClick={() => setFilesOpen((v) => !v)}
            >
              <FolderOpen className="size-3.5" />
              {t("peers.remote.files")}
            </Button>
          ) : null}
          <RemoteMessageList sessionId={sessionId} mode={mode} startScreen={startScreen} />
        </div>
        {filesOpen && canFiles ? <RemoteFiles sessionId={sessionId} peerName={name} onClose={() => setFilesOpen(false)} /> : null}
      </div>

      <div className="mx-auto w-full max-w-3xl pt-2">
        {!peer?.online ? (
          <div className="mb-1.5 flex items-center gap-2 text-xs text-destructive">
            <WifiOff className="size-3.5" />
            {t("peers.env.offline", { name })}
          </div>
        ) : null}
        {asks?.length ? (
          <div className="mb-2 flex flex-col gap-2">
            {asks
              .filter((a) => !a.batchId && a.kind !== "subchat")
              .map((ask) => (
                <AskCard key={ask.requestId} ask={ask} onReply={(requestId, value) => replyAsk(env, requestId, value)} />
              ))}
            {[...new Set(asks.map((a) => a.batchId).filter(Boolean))].map((batchId) => (
              <AskCardBatch
                key={batchId}
                items={asks.filter((a) => a.batchId === batchId)}
                onReply={(requestId, value) => replyAsk(env, requestId, value)}
              />
            ))}
          </div>
        ) : null}
        {waiting && (!asks?.length || asks.some((a) => a.kind === "subchat")) ? (
          <p className="mb-1.5 text-xs text-amber-600 dark:text-amber-400">{t("peers.remote.approvalNote", { name })}</p>
        ) : null}
        {!canSend && peer?.online ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            {t("peers.remote.viewOnlyNote", { name })}
          </div>
        ) : canSend ? (
          <RemoteComposer
            peerId={env}
            sessionId={sessionId}
            kind={mode}
            canControl={canControl}
            placeholder={t("peers.remote.inputPlaceholder", { name })}
            note={busy ? t("peers.remote.busyNote") : t("peers.remote.runsThere", { name })}
            sending={sending}
            onSubmit={submit}
          />
        ) : null}
        {error && messages ? <p className="mt-1 text-xs text-destructive">{t("peers.remote.sendError", { error })}</p> : null}
      </div>
    </div>
  )
}

/**
 * The new-chat screen of another desktop: the same title and subtitle the welcome of the
 * app shows for the mode picked in the sidebar, then the composer. The chat is only
 * created on that machine when the first message goes out — exactly like at home.
 */
function RemoteWelcome({ peerId, name, canSend, online }: { peerId: string; name: string; canSend: boolean; online: boolean }) {
  const { t } = useTranslation()
  const mode = useWorkspaceMode()
  const userName = useAppSettings((s) => s.settings.userName)
  const personaVisibility = useAppearanceStore((s) => s.personaVisibility)
  const homeFolderId = usePeersStore((s) => s.homeFolderId)
  const openSession = usePeersStore((s) => s.openSession)
  const send = usePeersStore((s) => s.send)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  // Code chats work in a folder of THAT machine: the "+" of a project folder carries its own,
  // otherwise the newest code chat's folder is the starting point (as at home).
  const suggested = usePeersStore((s) => {
    const folder = homeFolderId ? s.foldersByPeer[peerId]?.find((f) => f.id === homeFolderId) : undefined
    if (folder?.workspace?.[0]) return folder.workspace[0]
    const last = [...(s.sessionsByPeer[peerId] ?? [])]
      .filter((x) => x.mode === "code" && !x.archived && !x.parentId && !!x.directory)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return last?.directory
  })
  const [chosenFolder, setChosenFolder] = useState<string | undefined>(undefined)
  const directory = chosenFolder ?? suggested
  const control = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === peerId)?.grants.control === true)

  const title = t(pickWelcomeTitle({ mode, userName }), { name: userName ?? "" })
  const subtitle = mode === "chat" ? t("chat.empty.chatSubtitle") : t("chat.empty.codeSubtitle")

  const start = async ({ text, extras, commitDraft }: RemoteSubmit) => {
    setError(null)
    setStarting(true)
    try {
      const created = await peersApi.request<SessionInfo>(peerId, { type: "sessions:create", mode })
      if (!created?.id) throw new Error("create_failed")
      if (homeFolderId) {
        await peersApi.request(peerId, { type: "sessions:move-folder", sessionId: created.id, folderId: homeFolderId }).catch(() => {})
      }
      const id = remoteSessionId(peerId, created.id)
      // Ready before the first event of the new chat arrives, so none is dropped.
      usePeersStore.setState((s) => ({ messages: { ...s.messages, [id]: s.messages[id] ?? [] } }))
      openSession(id)
      // The choices made on this screen (model, modes, permission) become the new chat's own.
      await commitDraft(created.id)
      await send(id, text, { ...extras, ...(mode === "code" && directory ? { directory } : {}) })
    } catch (err) {
      setError((err as Error).message)
      throw err
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto">
        <div className="flex flex-col items-center gap-4 pt-40">
          {showsPersonaOnWelcome(personaVisibility) && (
            <div className="flex justify-center" style={{ width: "8rem", height: "8rem" }}>
              <Persona state="idle" className="!size-full" />
            </div>
          )}
          <div className={cn("flex flex-col items-center gap-2", !showsPersonaOnWelcome(personaVisibility) && "pt-36")}>
            <p className="whitespace-nowrap text-center text-lg font-medium text-foreground">{title}</p>
            <p className="max-w-md text-center text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl pt-2">
        {!online ? (
          <div className="mb-1.5 flex items-center gap-2 text-xs text-destructive">
            <WifiOff className="size-3.5" />
            {t("peers.env.offline", { name })}
          </div>
        ) : null}
        {canSend && mode === "code" && control ? (
          <div className="mb-1.5 flex items-center">
            <Button variant="ghost" size="sm" className="h-7 max-w-full gap-1.5 text-xs text-muted-foreground" onClick={() => setPickingFolder(true)}>
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">{directory ?? t("peers.remote.noFolder")}</span>
            </Button>
            <RemoteFolderPicker
              peerId={peerId}
              peerName={name}
              initial={directory}
              open={pickingFolder}
              onOpenChange={setPickingFolder}
              onPick={setChosenFolder}
            />
          </div>
        ) : null}
        {canSend ? (
          <RemoteComposer
            peerId={peerId}
            kind={mode}
            canControl={control && online}
            placeholder={t("peers.remote.inputPlaceholder", { name })}
            note={t("peers.remote.runsThere", { name })}
            sending={starting}
            onSubmit={start}
          />
        ) : online ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            {t("peers.remote.viewOnlyNote", { name })}
          </div>
        ) : null}
        {error ? <p className="mt-1 text-xs text-destructive">{t("peers.remote.sendError", { error })}</p> : null}
      </div>
    </div>
  )
}
