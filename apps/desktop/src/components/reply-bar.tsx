import { useTranslation } from "react-i18next"
import { MessageSquareQuoteIcon, XIcon } from "lucide-react"
import { replySnippet } from "@shared/chat"
import { useMessageReply } from "@/src/stores/message-reply"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/** Label of whoever wrote the replied message — the recorded text brings the
 *  role (`[assistant]`), and the translation comes from here. */
export function useReplyLabel() {
  const { t } = useTranslation()
  return (role: "user" | "assistant") => t(role === "user" ? "reply.you" : "reply.assistant")
}

/**
 * Quote of the replied message, as a badge in the context row above the
 * input — the SAME row as the attachment badges (it is the `leading` of
 * PromptInputAttachments that puts it there).
 *
 * It lives in the composer (and not only in the sent bubble) because it is what says what is going
 * to leave: without the badge, the sent text would get a quote nobody saw being
 * chosen. The X undoes the reply without touching the typed text.
 *
 * The drawing is the same as the attachments on purpose: a single row, badge height and
 * the excerpt cut at the end — that way it is read as "this goes along with the
 * message", and not as part of what one types.
 *
 * The width ceiling (`max-w-[60%]`) is what sustains "on the same row": without it
 * the long excerpt (up to 140 characters) takes the whole row and throws the attachment
 * badge down. With a short excerpt the ceiling does not act — the badge shrinks along.
 */
export function ReplyBar({ replyKey }: { replyKey: string }) {
  const { t } = useTranslation()
  const reply = useMessageReply((s) => s.replies[replyKey])
  const clearReply = useMessageReply((s) => s.clearReply)
  const label = useReplyLabel()
  if (!reply) return null

  return (
    <div className="flex h-8 max-w-[60%] select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm">
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-background">
        <MessageSquareQuoteIcon className="size-3 text-primary" />
      </span>
      
        <Truncate>
            <span className="min-w-0 flex-1 truncate">
            <span className="text-primary">{label(reply.role)}</span>
          <span className="text-muted-foreground">{" · "}{replySnippet(reply.text)}</span>
        </span>
        </Truncate>
      <Hint label={t("reply.cancel")}>
        <button
          type="button"

          aria-label={t("reply.cancel")}
          onClick={() => clearReply(replyKey)}
          className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </Hint>
    </div>
  )
}
