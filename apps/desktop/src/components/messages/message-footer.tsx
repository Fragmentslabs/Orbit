import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { FileIcon, TriangleAlertIcon } from "lucide-react"
import type { AssistantSnapshot } from "@shared/chat"

/**
 * Rodapé determinístico da mensagem do assistente (modo código): lista os
 * arquivos alterados no turno com estado e tamanho do diff, gerados pelo app
 * (snapshot do filesystem) — fora do texto do LLM, que pode dizer qualquer
 * coisa. Sem snapshot, nada é renderizado; se o rastreamento falhou, um aviso.
 */

type FileChangeKind = "created" | "modified" | "deleted"

interface FileChange {
  kind: FileChangeKind
  /** Número de hunks (@@) no diff unificado deste arquivo */
  hunks: number
}

/**
 * Extrai estado (criado/excluído/modificado) e nº de hunks por arquivo do
 * diff unificado. Arquivos presentes em `files` mas ausentes do patch (diff
 * truncado) simplesmente não ganham estatística — o caminho já é a verdade
 * vinda do snapshot.
 */
function parsePatchFileStats(patch: string | undefined): Map<string, FileChange> {
  const stats = new Map<string, FileChange>()
  if (!patch) return stats

  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const lines = section.split("\n")
    const kind: FileChangeKind = /^new file mode /m.test(section)
      ? "created"
      : /^deleted file mode /m.test(section)
        ? "deleted"
        : "modified"
    let path = ""
    for (const line of lines) {
      if (line.startsWith("+++ b/")) {
        path = line.slice("+++ b/".length)
        break
      }
    }
    if (!path) {
      for (const line of lines) {
        if (line.startsWith("--- a/")) {
          path = line.slice("--- a/".length)
          break
        }
      }
    }
    if (!path) continue
    const hunks = lines.filter((l) => l.startsWith("@@")).length
    stats.set(path, { kind, hunks })
  }
  return stats
}

function FileBadge({ stat }: { stat: FileChange }) {
  const { t } = useTranslation()
  if (stat.kind === "created") {
    return <span className="text-emerald-600 dark:text-emerald-400"> ({t("messageFooter.created")})</span>
  }
  if (stat.kind === "deleted") {
    return <span className="text-red-600 dark:text-red-400"> ({t("messageFooter.deleted")})</span>
  }
  if (stat.hunks > 0) {
    return <span> ({t("messageFooter.diffCount", { count: stat.hunks })})</span>
  }
  return null
}

export function MessageSnapshotFooter({ snapshot }: { snapshot?: AssistantSnapshot }) {
  const { t } = useTranslation()
  const fileStats = useMemo(() => parsePatchFileStats(snapshot?.patch), [snapshot?.patch])

  // Rastreamento falhou: snapshot existe mas não há tree inicial/final
  if (snapshot && (snapshot.failed === true || snapshot.start == null)) {
    return (
      <div className="mt-1 flex w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
        <TriangleAlertIcon className="size-3 shrink-0" />
        <span>{t("messageFooter.failed")}</span>
      </div>
    )
  }

  const files = snapshot?.files
  if (!files || files.length === 0) return null

  return (
    <div className="mt-1 w-full rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <FileIcon className="size-3 shrink-0" />
        <span>{t("messageFooter.title")}</span>
      </div>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {files.map((file) => {
          const stat = fileStats.get(file)
          return (
            <li key={file} className="truncate" title={file}>
              <span className="text-foreground/80">{file}</span>
              {stat && <FileBadge stat={stat} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
