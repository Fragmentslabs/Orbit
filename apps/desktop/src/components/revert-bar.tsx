import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, History, Undo2, MessageSquareText, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SessionInfo } from "@shared/chat"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Barra exibida acima do input enquanto um revert está ativo:
 * - Modo código: resumo dos arquivos alterados desfeitos + "Desfazer" (unrevert).
 * - Modo chat: indica que a conversa foi truncada até o ponto revertido.
 * Pode ser fechada com o X (não desfaz o revert, só esconde a barra).
 */
export function RevertBar({ session }: { session: SessionInfo }) {
  const { t } = useTranslation()
  const unrevert = useSessionStore((s) => s.unrevert)
  const [showDiff, setShowDiff] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const revert = session.revert
  if (!revert || dismissed) return null

  const isCode = Boolean(revert.files || revert.diff)
  const count = revert.files?.length ?? 0
  const label = isCode
    ? count === 0
      ? t("revert.filesRevertedNone")
      : count === 1
        ? t("revert.filesRevertedOne")
        : t("revert.filesRevertedMany", { n: count })
    : t("revert.conversationReverted")

  return (
    <div className="rounded-lg border bg-muted/40 text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        {isCode
          ? <History className="size-3.5 shrink-0 text-muted-foreground" />
          : <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
        }
        <span className="flex-1 truncate">
          {label}
          <span className="text-muted-foreground"> — {t("revert.continueFromHere")}</span>
        </span>
        {revert.diff && (
          <button
            type="button"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowDiff((v) => !v)}
          >
            {t("revert.diff")}
            <ChevronDown className={cn("size-3 transition-transform", showDiff && "rotate-180")} />
          </button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => void unrevert(session.id)}
        >
          <Undo2 className="size-3" />
          {t("revert.unrevert")}
        </Button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          title={t("common.close")}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {showDiff && revert.diff && (
        <pre className="max-h-56 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {revert.diff}
        </pre>
      )}
    </div>
  )
}
