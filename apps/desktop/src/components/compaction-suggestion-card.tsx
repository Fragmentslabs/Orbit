import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight, Loader2, NotebookPen, X } from "lucide-react"
import { chatApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Oferta ao FIM do turno, quando a próxima compactação passaria do limite de
 * resumos (ver maybeSuggestCompaction no engine). Uma ou duas compactações
 * funcionam bem; da terceira em diante o resumo já é um resumo de resumo, e o
 * começo da conversa — o porquê das decisões — vai embora primeiro.
 *
 * Fica NA CONVERSA, no fim do fluxo, como os outros cards: não ocupa a faixa
 * fixa acima do input. É oferta, não bloqueio — ignorada, a compactação
 * automática do próximo turno roda como sempre.
 */
export function CompactionSuggestionCard({
  sessionId,
  summaries,
  threshold,
}: {
  sessionId: string
  /** Compactações já feitas (= resumos no histórico) */
  summaries: number
  /** A partir de quantas o card aparece (configuração) */
  threshold: number
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<null | "compact" | "new">(null)
  const [failed, setFailed] = useState(false)

  const compactHere = async () => {
    setBusy("compact")
    setFailed(false)
    try {
      await chatApi.compact(sessionId)
      // A compactação em si muda a contagem de resumos e já esconde o card;
      // dispensar aqui cobre a corrida (evento de mensagens ainda a caminho).
      useSessionStore.getState().dismissCompactionSuggestion(sessionId)
    } finally {
      setBusy(null)
    }
  }

  const continueInNewChat = async () => {
    setBusy("new")
    setFailed(false)
    try {
      // O brief é gerado no main (modelo auxiliar), a partir do resumo atual
      // mais a cauda da conversa. Sem ele não há como começar o chat novo.
      const result = await chatApi.continuationBrief(sessionId)
      if (!result) {
        setFailed(true)
        return
      }
      const child = await useSessionStore
        .getState()
        .createContinuationSession(sessionId, result.title, result.text)
      if (child) await useSessionStore.getState().selectSession(child.mode, child.id)
    } finally {
      setBusy(null)
    }
  }

  const disabled = busy !== null

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-start gap-2">
        <NotebookPen className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("chat.compactionSuggest.title")}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t("chat.compactionSuggest.body", { count: summaries })}
          </p>
          {failed && (
            <p className="mt-1 text-xs text-destructive">{t("chat.compactionSuggest.failed")}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => useSessionStore.getState().dismissCompactionSuggestion(sessionId)}
          aria-label={t("chat.compactionSuggest.dismiss")}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-6">
        <button
          type="button"
          disabled={disabled}
          onClick={continueInNewChat}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy === "new" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowRight className="size-3.5" />
          )}
          {t("chat.compactionSuggest.newChat")}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={compactHere}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-foreground/5 disabled:opacity-50"
        >
          {busy === "compact" && <Loader2 className="size-3.5 animate-spin" />}
          {t("chat.compactionSuggest.compactHere")}
        </button>
        <span className="text-[11px] text-muted-foreground">
          {t("chat.compactionSuggest.hint", { threshold })}
        </span>
      </div>
    </div>
  )
}
