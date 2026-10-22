import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { MessagePart } from "@shared/chat"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Selo "+N -N" do turno: as linhas que as ferramentas somaram e tiraram do
 * working tree, com o diff aberto no painel ao clicar.
 *
 * Ele mora no RODAPÉ da mensagem (canto direito, na linha de copiar/falar/
 * gastos), e não no cabeçalho do acordeon de ações: o acordeon se recolhe
 * sozinho quando o turno termina, e o balanço do que mudou é justamente o que
 * se procura no FIM da mensagem. O modo detalhado também não perde o selo.
 */

/** O turno mexeu em arquivo? `bash` também altera o working tree, mas o selo
 *  promete o diff das edições — sem nenhuma, ele não tem o que abrir. */
function wroteFiles(parts: MessagePart[]): boolean {
  return parts.some((p) => p.type === "tool" && (p.tool === "write" || p.tool === "edit"))
}

/** Linhas somadas/removidas no patch unificado do snapshot (os cabeçalhos
 *  "+++"/"---" não contam). */
function diffCountsOf(patch?: string): { added: number; removed: number } | null {
  if (!patch) return null
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  if (added === 0 && removed === 0) return null
  return { added, removed }
}

export function DiffBadge({ patch, parts, sessionId, messageId }: {
  /** Patch unificado do snapshot do turno (message.snapshot.patch). */
  patch?: string
  /** Partes do turno — é delas que sai "houve edição de arquivo". */
  parts: MessagePart[]
  sessionId?: string
  messageId?: string
}) {
  const { t } = useTranslation()
  const counts = useMemo(() => diffCountsOf(patch), [patch])
  if (!counts || !sessionId || !messageId || !wroteFiles(parts)) return null

  return (
    <button
      type="button"
      title={t("diff.open")}
      onClick={() => usePanelStore.getState().openDiff(sessionId, messageId, "Diff")}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {counts.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{counts.added}</span>}
      {counts.removed > 0 && <span className="text-red-600 dark:text-red-400">-{counts.removed}</span>}
    </button>
  )
}
