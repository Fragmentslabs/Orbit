import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, FolderOpen, Loader2, Lock, Network, RefreshCw, Send, Square } from "lucide-react"
import type { ChatMessage, FilePart } from "@shared/chat"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Message, MessageContent } from "@/src/components/ai/message"
import { ChatAssistantMessage } from "@/src/components/messages/chat-message"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { ErrorBoundary } from "@/src/components/error-boundary"
import { visibleMessageText } from "@/src/lib/message-utils"
import { isRemoteRunning, useActiveRemoteSession, usePeersStore } from "@/src/stores/peers-store"
import { RemoteFiles } from "./remote-files"

/**
 * A chat of another desktop, read live over the pinned connection.
 *
 * The messages go through the same components as a local chat, with the
 * namespaced session id — that is what makes a motion/design/slides card, an
 * image or an audio of that machine open from here (main routes the piece IPCs
 * and the orbit-* schemes to the peer). What this view does NOT offer is on
 * purpose: approvals, revert, fork, attachments — those belong to the machine
 * that runs the agent.
 */
export function RemoteChatView() {
  const { t } = useTranslation()
  const env = usePeersStore((s) => s.env)
  const peer = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === s.env))
  const setEnv = usePeersStore((s) => s.setEnv)
  const active = useActiveRemoteSession()
  const sessionId = active?.sessionId ?? null
  const session = active?.session
  const messages = usePeersStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  const loading = usePeersStore((s) => (sessionId ? !!s.loading[sessionId] : false))
  const error = usePeersStore((s) => (sessionId ? s.errors[sessionId] : undefined))
  const status = usePeersStore((s) => (sessionId ? s.statuses[sessionId] : undefined))
  const sending = usePeersStore((s) => (sessionId ? !!s.sending[sessionId] : false))
  const waiting = usePeersStore((s) => !!s.snapshot?.running.find((r) => r.sessionId === sessionId)?.waiting)
  const loadMessages = usePeersStore((s) => s.loadMessages)
  const send = usePeersStore((s) => s.send)
  const abort = usePeersStore((s) => s.abort)
  const [text, setText] = useState("")
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

  const submit = async () => {
    const value = text.trim()
    if (!sessionId || !value || !canSend || busy || sending) return
    try {
      await send(sessionId, value)
      setText("")
      stick.current = true
    } catch {
      /* the error shows under the input */
    }
  }

  const banner = (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
      <Network className="size-3.5 text-primary" />
      <span className="font-medium text-foreground">{t("peers.env.remoteBanner", { name })}</span>
      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
        {canSend ? t("peers.env.canSend") : t("peers.env.viewOnly")}
      </span>
      {!peer?.online ? <span className="text-destructive">{t("peers.env.offline", { name })}</span> : null}
      <span className="flex-1" />
      {sessionId && canFiles ? (
        <Button variant={filesOpen ? "secondary" : "ghost"} size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setFilesOpen((v) => !v)}>
          <FolderOpen className="size-3.5" />
          {t("peers.remote.files")}
        </Button>
      ) : null}
      {sessionId ? (
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void loadMessages(sessionId, true)}>
          <RefreshCw className="size-3.5" />
          {t("peers.remote.reload")}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setEnv("local")}>
        <ArrowLeft className="size-3.5" />
        {t("peers.env.back")}
      </Button>
    </div>
  )

  if (env === "local") return null
  if (!sessionId) {
    return (
      <div className="flex h-full flex-col">
        {banner}
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("peers.remote.pick", { name })}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {banner}
      <div className="flex min-h-0 flex-1 gap-3">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
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
        </div>
        {filesOpen && canFiles ? <RemoteFiles sessionId={sessionId} peerName={name} onClose={() => setFilesOpen(false)} /> : null}
      </div>

      <div className="mx-auto w-full max-w-3xl pt-2">
        {waiting ? <p className="mb-1.5 text-xs text-amber-600 dark:text-amber-400">{t("peers.remote.approvalNote", { name })}</p> : null}
        {!canSend ? (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            {t("peers.remote.viewOnlyNote", { name })}
          </div>
        ) : (
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
              disabled={!canSend}
              rows={2}
              placeholder={t("peers.remote.inputPlaceholder", { name })}
              className="block max-h-48 min-h-[44px] w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-2 px-1 pt-1">
              <span className="flex-1 truncate text-[11px] text-muted-foreground">
                {busy ? t("peers.remote.busyNote") : t("peers.remote.runsThere", { name })}
              </span>
              {busy ? (
                <Button size="sm" variant="secondary" className="h-7 gap-1.5 text-xs" onClick={() => void abort(sessionId)}>
                  <Square className="size-3" />
                  {t("peers.remote.stop")}
                </Button>
              ) : (
                <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={!text.trim() || sending || !canSend} onClick={() => void submit()}>
                  {sending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
                  {t("peers.remote.send")}
                </Button>
              )}
            </div>
          </div>
        )}
        {error && messages ? <p className="mt-1 text-xs text-destructive">{t("peers.remote.sendError", { error })}</p> : null}
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
