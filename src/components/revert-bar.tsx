import { useState } from "react"
import { ChevronDown, History, Undo2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SessionInfo } from "@/shared/chat"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Barra exibida acima do input enquanto um revert está ativo: resumo das
 * alterações desfeitas + "Desfazer" (unrevert). Enviar nova mensagem
 * consolida o revert (o main descarta as mensagens posteriores).
 */
export function RevertBar({ session }: { session: SessionInfo }) {
  const unrevert = useSessionStore((s) => s.unrevert)
  const [showDiff, setShowDiff] = useState(false)
  const revert = session.revert
  if (!revert) return null

  const count = revert.files?.length ?? 0
  const label =
    count === 0
      ? "Arquivos revertidos"
      : count === 1
        ? "1 arquivo revertido"
        : `${count} arquivos revertidos`

  return (
    <div className="rounded-lg border bg-muted/40 text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <History className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">
          {label}
          <span className="text-muted-foreground"> — nova mensagem continua deste ponto</span>
        </span>
        {revert.diff && (
          <button
            type="button"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowDiff((v) => !v)}
          >
            Diff
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
          Desfazer
        </Button>
      </div>
      {showDiff && revert.diff && (
        <pre className="max-h-56 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {revert.diff}
        </pre>
      )}
    </div>
  )
}
