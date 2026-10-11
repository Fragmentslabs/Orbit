import { useTranslation } from "react-i18next"
import { ReplyIcon, XIcon } from "lucide-react"
import { replySnippet } from "@shared/chat"
import { useMessageReply } from "@/src/stores/message-reply"

/** Rótulo de quem escreveu a mensagem respondida — o texto gravado traz o
 *  papel (`[assistant]`), e a tradução sai daqui. */
export function useReplyLabel() {
  const { t } = useTranslation()
  return (role: "user" | "assistant") => t(role === "user" ? "reply.you" : "reply.assistant")
}

/**
 * Citação da mensagem respondida, acima do campo de texto.
 *
 * Fica no compositor (e não só na bolha enviada) porque é ele que diz o que
 * vai sair: sem a barra, o texto enviado ganharia uma citação que ninguém viu
 * sendo escolhida. O X desfaz a resposta sem mexer no texto digitado.
 */
export function ReplyBar({ replyKey }: { replyKey: string }) {
  const { t } = useTranslation()
  const reply = useMessageReply((s) => s.replies[replyKey])
  const clearReply = useMessageReply((s) => s.clearReply)
  const label = useReplyLabel()
  if (!reply) return null

  return (
    <div className="mx-3 mb-1.5 flex items-start gap-2 rounded-r-md border-l-2 border-primary bg-muted/50 px-2 py-1">
      <ReplyIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-primary">{label(reply.role)}</p>
        <p className="truncate text-[11px] text-muted-foreground">{replySnippet(reply.text)}</p>
      </div>
      <button
        type="button"
        title={t("reply.cancel")}
        aria-label={t("reply.cancel")}
        onClick={() => clearReply(replyKey)}
        className="mt-0.5 shrink-0 cursor-pointer rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
