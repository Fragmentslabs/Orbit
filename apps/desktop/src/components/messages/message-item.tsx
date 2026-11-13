import { memo, useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, GitBranch, PaperclipIcon } from "lucide-react"
import type { ChatMessage, FilePart } from "@shared/chat"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Actions } from "@/src/components/ai/actions"
import { Message, MessageAttachment, MessageAttachments, MessageContent } from "@/src/components/ai/message"
import { ChatAssistantMessage } from "@/src/components/messages/chat-message"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { AudioPlayerCard } from "@/src/components/messages/audio-part"
import {
  AssistantMessageActions,
  CopyAction,
  MessageTimestamp,
  ReplyAction,
  RevertAction,
  UserMessageQuote,
  UserMessageText,
} from "@/src/components/messages/shared"
import { docsApi } from "@/src/lib/ipc"
import type { SendConfig } from "@/src/stores/session-store"
import { messageText, visibleMessageText } from "@/src/lib/message-utils"
import { usePanelStore } from "@/src/stores/panel-store"

/** Extensions that become a conversation document — it is what decides whether the chip opens. */
const DOCUMENT_FILE = /\.(pdf|docx|xlsx|xls|ods|csv)$/i

/**
 * Chip of the non-image attachment. Clicking opens the file in the panel.
 *
 * The `documentId` comes in the chip since it started being recorded; in attachments
 * older than that it does not exist, and then the document is found again by NAME
 * among the conversation sources. Without that rescue, every old message would be left
 * with a permanently inert attachment.
 *
 * The NAME is also the plan B for an id that no longer resolves: dragging the file
 * to the folder sources swaps doc1 for src1, and the chip keeps the id as it
 * was on the day of sending. The backend follows the trail by itself, but here the name is
 * better proof — it identifies the file even when the conversation promoted
 * two documents and the trail was lost.
 */
function DocumentChip({ file, sessionId }: { file: FilePart; sessionId?: string }) {
  const { t } = useTranslation()
  // Source attached by reference (dragged from the Sources tab): the id ALREADY is the
  // address of the document, so the chip opens it directly — without going through the list.
  const openable =
    Boolean(sessionId) &&
    (!!file.sourceId || !!file.documentId || DOCUMENT_FILE.test(file.filename ?? ""))

  const open = async () => {
    if (!sessionId) return
    if (file.sourceId) {
      usePanelStore.getState().openSourceTab(sessionId, {
        docId: file.sourceId,
        page: 1,
        title: file.filename ?? file.sourceId,
      })
      return
    }
    let docId = file.documentId
    const { shared, own } = await docsApi.list(sessionId)
    const docs = [...own, ...shared]
    if (!docId || !docs.some((d) => d.id === docId)) {
      docId = docs.find((d) => d.filename === file.filename)?.id ?? docId
    }
    if (!docId) return
    usePanelStore.getState().openSourceTab(sessionId, {
      docId,
      page: 1,
      title: file.filename ?? docId,
    })
  }

  return (
    <Hint label={openable ? t("sources.openInPanel") : ""}>
      <button
        type="button"
        disabled={!openable}
        onClick={() => void open()}
        className="flex h-7 select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm enabled:cursor-pointer enabled:hover:bg-accent disabled:cursor-default"
      >
        <PaperclipIcon className="size-3 text-muted-foreground" />
        <span className="truncate">{file.filename ?? t("attachments.unnamedFile")}</span>
      </button>
    </Hint>
  )
}

/**
 * One message of a conversation, exactly as the main chat draws it: the user's bubble with
 * its attachments and hover actions, and the assistant's answer with whatever it brought
 * inline (cards, tool steps, media) plus the reading footer under it — copy, speak, time,
 * cost, retry. Every conversation surface reuses it, so a chat on a screen (the fragment
 * column, the artifact feeds) looks and behaves like the one in the middle of the app.
 */
const MessageItem = memo(
  function MessageItem({ msg, isLast, waiting, finished, isBusy, busyLabel, mode, sessionId, sendMessage, messages, index }: {
    msg: ChatMessage
    isLast: boolean
    waiting: boolean
    finished: boolean
    isBusy: boolean
    busyLabel?: string
    mode: "chat" | "code"
    sessionId?: string
    sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
    messages: ChatMessage[]
    index: number
  }) {
  const { t } = useTranslation()
  // The message of an execution that is still running has no answer yet: the reading footer
  // (copy, speak, time, cost) would be measuring nothing.
  const runningRun = msg.parts.some(
    (part) => part.type === "routine-run" && part.status === "running",
  )

  const handleRetry = useCallback(() => {
    const prevUser = [...messages].slice(0, index).reverse().find((m) => m.role === "user")
    if (prevUser && sessionId) {
      // Redoes the turn IN PLACE: the main process discards this failed reply and reuses
      // the user message (with its attachments) instead of sending a new one —
      // no duplicated bubble and no error card left in the history.
      void sendMessage(mode, messageText(prevUser), { options: {}, sessionId, retryOf: msg.id })
    }
  }, [messages, index, mode, sessionId, sendMessage, msg.id])

  // A subchat's result that woke this conversation up: not something the user typed,
  // so it does not get a user bubble (see electron/lib/subchat-wake.ts).
  if (msg.role === "user" && msg.origin === "subchat") {
    return <SubchatResultNotice message={msg} />
  }

  if (msg.role === "user") {
    const files = msg.parts.filter((p): p is FilePart => p.type === "file")
    /** The text the bubble shows — attachment notes, chips and the reply pill are not it.
     *  A message can arrive with NO text at all (a pasted text becomes an attachment, a
     *  PDF is sent on its own), and the bubble was then rendered empty: a blank box
     *  right below the chips, which reads like a broken message. */
    const text = visibleMessageText(msg)
    return (
      <Message from="user" data-user-msg-id={msg.id} data-msg-id={msg.id} data-msg-role="user">
        <div className="group/user-msg flex flex-col">
          {files.length > 0 && (
            // With no text the attachments ARE the message: the row takes the
            // `data-msg-surface` (target of the jump ring) that the bubble would carry.
            <MessageAttachments className="mb-1" data-msg-surface={text ? undefined : ""}>
              {files.map((file) =>
                file.mime.startsWith("image/") ? (
                  <MessageAttachment
                    key={file.id}
                    // `mediaUrl` goes along: the chip's `url` is only the thumbnail
                    // of the bubble, and it is what the viewer enlarges and what the
                    // copy and save buttons hand over. Omitting it here made
                    // the "save" return a 320px webp instead of the photo.
                    data={{
                      type: "file",
                      mediaType: file.mime,
                      filename: file.filename,
                      url: file.url,
                      mediaUrl: file.mediaUrl,
                    }}
                  />
                ) : file.mime.startsWith("video/") && file.url ? (
                  // Attached video: the main process stored the file and left a frame as
                  // a thumbnail in the chip. The bubble shows that frame (the video itself only
                  // the agent reaches, by reference).
                  <MessageAttachment
                    key={file.id}
                    data={{ type: "file", mediaType: "image/webp", filename: file.filename, url: file.url }}
                  />
                ) : file.mime.startsWith("audio/") && file.mediaUrl ? (
                  // Attached audio: plays in the bubble itself. What it says (if the
                  // agent transcribes it) stays in the attachment note, not here.
                  <AudioPlayerCard
                    key={file.id}
                    className="w-72 max-w-full"
                    src={file.mediaUrl}
                    title={file.filename || t("audio.attachment")}
                  />
                ) : (
                  // An attachment that became a document opens in the panel; the others (loose
                  // text, browser element) have nothing to open — their
                  // content is in the message itself.
                  <DocumentChip key={file.id} file={file} sessionId={sessionId} />
                ),
              )}
            </MessageAttachments>
          )}
          {/* Quote of the replied message: a pill ABOVE the bubble, on the chat
              surface — outside `MessageContent`, so it does not inherit the bubble's
              background and padding. */}
          <UserMessageQuote text={text} />
          {/* `data-msg-surface`: target of the ring of the jump to the message (search,
              gallery, artifact) — the ring goes on the bubble, which is rounded, and
              not on the wrapper of the row, which is rectangular (see message-jump).
              Without text there is no bubble at all (see above). */}
          {text && (
            <MessageContent data-msg-surface>
              <UserMessageText text={text} />
            </MessageContent>
          )}
          <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
            <MessageTimestamp timestamp={msg.createdAt} />
            {text && <CopyAction text={text} />}
            <ReplyAction message={msg} sessionId={sessionId} />
            {/* Speak reads the assistant's REPLY — the user message does not
                get the button (nothing of it is read aloud). */}
            <RevertAction messageId={msg.id} sessionId={sessionId} />
          </Actions>
        </div>
      </Message>
    )
  }

  return (
    <Message from="assistant" data-msg-id={msg.id} data-msg-role="assistant">
      <MessageContent data-msg-surface>
        {mode === "chat" ? (
          <ChatAssistantMessage
            message={msg}
            sessionId={sessionId}
            isLast={isLast}
            isBusy={isBusy}
            busyLabel={busyLabel}
            onRetry={handleRetry}
          />
        ) : (
          // `diffInFooter`: the "+N -N" comes out in the footer of the message, next to the
          // other actions — and not in the accordion header, which collapses.
          <CodeAssistantMessage
            message={msg}
            sessionId={sessionId}
            isLast={isLast}
            isBusy={isBusy}
            busyLabel={busyLabel}
            onRetry={handleRetry}
            diffInFooter
          />
        )}
      </MessageContent>
      {finished && !waiting && !runningRun && (
        <AssistantMessageActions message={msg} sessionId={sessionId} />
      )}
    </Message>
  )
  },
  (prev, next) =>
    prev.msg === next.msg &&
    prev.isLast === next.isLast &&
    prev.waiting === next.waiting &&
    prev.finished === next.finished &&
    prev.isBusy === next.isBusy &&
    prev.busyLabel === next.busyLabel &&
    prev.mode === next.mode &&
    prev.sessionId === next.sessionId &&
    prev.index === next.index,
)

export { MessageItem }

/** The result a subchat sent back: its first line as the title, the rest folded. */
function SubchatResultNotice({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const text = messageText(message)
  const [head, ...rest] = text.split("\n")
  const body = rest.join("\n").trim()
  return (
    <div data-msg-id={message.id} data-msg-role="user" className="my-1 flex flex-col gap-1 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs">
      <button
        type="button"
        className="flex items-center gap-2 text-left font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="flex-1">{head}</span>
        {body && <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />}
      </button>
      {body && (
        <p className={cn("whitespace-pre-wrap break-words text-muted-foreground", !open && "line-clamp-2")}>{body}</p>
      )}
      {!body && <p className="text-muted-foreground">{t("subchat.noResult")}</p>}
    </div>
  )
}
