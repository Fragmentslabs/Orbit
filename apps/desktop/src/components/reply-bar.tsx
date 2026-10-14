import { useTranslation } from "react-i18next"
import { MessageSquareQuoteIcon, XIcon } from "lucide-react"
import { replySnippet } from "@shared/chat"
import { useMessageReply } from "@/src/stores/message-reply"

/** Rótulo de quem escreveu a mensagem respondida — o texto gravado traz o
 *  papel (`[assistant]`), e a tradução sai daqui. */
export function useReplyLabel() {
  const { t } = useTranslation()
  return (role: "user" | "assistant") => t(role === "user" ? "reply.you" : "reply.assistant")
}

/**
 * Citação da mensagem respondida, como badge na linha de contexto acima do
 * input — a MESMA linha dos badges de anexo (é o `leading` do
 * PromptInputAttachments que a coloca lá).
 *
 * Vive no compositor (e não só na bolha enviada) porque é ela que diz o que vai
 * sair: sem o badge, o texto enviado ganharia uma citação que ninguém viu sendo
 * escolhida. O X desfaz a resposta sem mexer no texto digitado.
 *
 * O desenho é o mesmo dos anexos de propósito: uma linha só, altura de badge e
 * o trecho cortado no fim — assim ela é lida como "isto vai junto com a
 * mensagem", e não como parte do que se digita.
 *
 * O teto de largura (`max-w-[60%]`) é o que sustenta "na mesma linha": sem ele
 * o trecho longo (até 140 caracteres) ocupa a linha inteira e joga o badge do
 * anexo para baixo. Com trecho curto o teto não age — o badge encolhe junto.
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
      <span className="min-w-0 flex-1 truncate">
        <span className="text-primary">{label(reply.role)}</span>
        <span className="text-muted-foreground">{" · "}{replySnippet(reply.text)}</span>
      </span>
      <button
        type="button"
        title={t("reply.cancel")}
        aria-label={t("reply.cancel")}
        onClick={() => clearReply(replyKey)}
        className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
