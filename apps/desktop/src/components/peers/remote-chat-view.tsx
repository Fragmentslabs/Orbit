import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { FolderOpen, Loader2, Lock, Send, Square, WifiOff } from "lucide-react"
import type { ChatMessage, FilePart, SessionInfo } from "@shared/chat"
import { showsPersonaOnWelcome } from "@shared/appearance"
import { remoteSessionId } from "@shared/peers"
import { pickWelcomeTitle } from "@shared/welcome-title"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useWorkspaceMode } from "@/lib/workspace-context"
import { Persona } from "@/src/components/ai/persona"
import { Message, MessageContent } from "@/src/components/ai/message"
import { ChatAssistantMessage } from "@/src/components/messages/chat-message"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { ErrorBoundary } from "@/src/components/error-boundary"
import { peersApi } from "@/src/lib/ipc"
import { visibleMessageText } from "@/src/lib/message-utils"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import { useAppSettings } from "@/src/stores/app-settings"
import { isRemoteRunning, useActiveRemoteSession, usePeersStore } from "@/src/stores/peers-store"
import { RemoteFiles } from "./remote-files"

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
 * peer). What this view does NOT offer is on purpose: approvals, revert, fork,
 * attachments — those belong to the machine that runs the agent.
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
  const loading = usePeersStore((s) => (sessionId ? !!s.loading[sessionId] : false))
  const error = usePeersStore((s) => (sessionId ? s.errors[sessionId] : undefined))
  const status = usePeersStore((s) => (sessionId ? s.statuses[sessionId] : undefined))
  const sending = usePeersStore((s) => (sessionId ? !!s.sending[sessionId] : false))
  const waiting = usePeersStore((s) => !!s.snapshot?.running.find((r) => r.sessionId === sessionId)?.waiting)
  const loadMessages = usePeersStore((s) => s.loadMessages)
  const send = usePeersStore((s) => s.send)
  const abort = usePeersStore((s) => s.abort)
  const [filesOpen, setFilesOpen] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const name = peer?.name ?? ""
  const busy = isRemoteRunning(status)
  const canSend = (!!peer?.grants.control || !!peer?.grants.send) && !!peer?.online
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
    stick.current = true
  }, [sessionId])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  if (env === "local") return null

  // No chat open: the new-chat screen, in the mode the sidebar is on.
  if (!sessionId) {
    return <RemoteWelcome peerId={env} name={name} canSend={canSend} online={!!peer?.online} />
  }

  const submit = async (value: string) => {
    if (!value || !canSend || busy || sending) return
    await send(sessionId, value)
    stick.current = true
  }

  const empty = !loading && (messages?.length ?? 0) === 0 && !!startScreen

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 gap-3">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
          className="relative min-h-0 flex-1 overflow-y-auto"
        >
          {sessionId && canFiles ? (
            <Button
              variant={filesOpen ? "secondary" : "ghost"}
              size="sm"
              className="sticky top-0 z-10 float-right mr-2 h-7 gap-1.5 text-xs"
              onClick={() => setFilesOpen((v) => !v)}
            >
              <FolderOpen className="size-3.5" />
              {t("peers.remote.files")}
            </Button>
          ) : null}
          {empty ? (
            <div className="flex w-full flex-col items-center pt-24">{startScreen}</div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4 px-2 pb-6">
              {loading && !messages ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("peers.remote.loading")}
                </div>
              ) : null}
              {error && !messages ? (
                <p className="py-10 text-center text-sm text-destructive">{t("peers.remote.loadError", { error })}</p>
              ) : null}
              {(messages ?? []).map((msg, index, all) => (
                <ErrorBoundary key={msg.id} label="remote-message" fallback={() => <p className="text-xs text-muted-foreground">…</p>}>
                  <RemoteMessage
                    msg={msg}
                    mode={mode}
                    sessionId={sessionId}
                    isLast={index === all.length - 1}
                    isBusy={busy && index === all.length - 1}
                  />
                </ErrorBoundary>
              ))}
            </div>
          )}
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
        {waiting ? <p className="mb-1.5 text-xs text-amber-600 dark:text-amber-400">{t("peers.remote.approvalNote", { name })}</p> : null}
        {!canSend && peer?.online ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            {t("peers.remote.viewOnlyNote", { name })}
          </div>
        ) : canSend ? (
          <RemoteComposer
            placeholder={t("peers.remote.inputPlaceholder", { name })}
            note={busy ? t("peers.remote.busyNote") : t("peers.remote.runsThere", { name })}
            busy={busy}
            sending={sending}
            onSubmit={submit}
            onStop={() => void abort(sessionId)}
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

  const title = t(pickWelcomeTitle({ mode, userName }), { name: userName ?? "" })
  const subtitle = mode === "chat" ? t("chat.empty.chatSubtitle") : t("chat.empty.codeSubtitle")

  const start = async (text: string) => {
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
      await send(id, text)
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
        {canSend ? (
          <RemoteComposer
            placeholder={t("peers.remote.inputPlaceholder", { name })}
            note={t("peers.remote.runsThere", { name })}
            busy={false}
            sending={starting}
            onSubmit={start}
            onStop={() => {}}
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

function RemoteComposer({ placeholder, note, busy, sending, onSubmit, onStop }: {
  placeholder: string
  note: string
  busy: boolean
  sending: boolean
  onSubmit: (text: string) => Promise<void>
  onStop: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState("")
  const submit = async () => {
    const value = text.trim()
    if (!value || busy || sending) return
    try {
      await onSubmit(value)
      setText("")
    } catch {
      /* the error shows under the input */
    }
  }
  return (
    <div className="rounded-xl border bg-background p-2 shadow-sm">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        rows={2}
        placeholder={placeholder}
        className="block max-h-48 min-h-[44px] w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-2 px-1 pt-1">
        <span className="flex-1 truncate text-[11px] text-muted-foreground">{note}</span>
        {busy ? (
          <Button size="sm" variant="secondary" className="h-7 gap-1.5 text-xs" onClick={onStop}>
            <Square className="size-3" />
            {t("peers.remote.stop")}
          </Button>
        ) : (
          <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={!text.trim() || sending} onClick={() => void submit()}>
            {sending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
            {t("peers.remote.send")}
          </Button>
        )}
      </div>
    </div>
  )
}

function RemoteMessage({ msg, mode, sessionId, isLast, isBusy }: {
  msg: ChatMessage
  mode: "chat" | "code"
  sessionId: string
  isLast: boolean
  isBusy: boolean
}) {
  if (msg.role === "user") {
    const text = visibleMessageText(msg)
    const images = msg.parts.filter((p): p is FilePart => p.type === "file" && p.mime.startsWith("image/") && !!p.url)
    const others = msg.parts.filter((p): p is FilePart => p.type === "file" && !p.mime.startsWith("image/"))
    return (
      <Message from="user" data-msg-id={msg.id}>
        <div className="flex flex-col items-end gap-1">
          {images.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              {images.map((file) => (
                <img key={file.id} src={file.url} alt={file.filename ?? ""} className="max-h-40 rounded-lg border object-cover" />
              ))}
            </div>
          ) : null}
          {others.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              {others.map((file) => (
                <span key={file.id} className="rounded-md border bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground">
                  {file.filename || file.mime}
                </span>
              ))}
            </div>
          ) : null}
          {text ? (
            <MessageContent>
              <p className="whitespace-pre-wrap break-words">{text}</p>
            </MessageContent>
          ) : null}
        </div>
      </Message>
    )
  }
  return (
    <Message from="assistant" data-msg-id={msg.id}>
      <MessageContent className={cn("w-full")}>
        {mode === "chat" ? (
          <ChatAssistantMessage message={msg} sessionId={sessionId} isLast={isLast} isBusy={isBusy} />
        ) : (
          <CodeAssistantMessage message={msg} sessionId={sessionId} isLast={isLast} isBusy={isBusy} />
        )}
      </MessageContent>
    </Message>
  )
}
