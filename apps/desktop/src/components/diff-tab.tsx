import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import type { ChatMessage } from "@shared/chat"
import { useSessionStore } from "@/src/stores/session-store"
import { SEM_TASKS, useEsteiraStore } from "@/src/stores/esteira-store"
import { parsePatch, type FileDiff } from "@/lib/unified-diff"
import { HighlightedDiffFile } from "@/src/components/diff-lines"
import { cn } from "@/lib/utils"

function FileDiffSection({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(false)
  const label = file.oldPath === file.newPath ? file.oldPath : `${file.oldPath} → ${file.newPath}`
  return (
    <div className="mb-3 overflow-hidden rounded-md border border-border/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent/50"
      >
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open ? "rotate-0" : "-rotate-90")} />
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
          {file.added > 0 && <span className="text-emerald-500">+{file.added}</span>}
          {file.removed > 0 && <span className="text-red-500">-{file.removed}</span>}
        </span>
      </button>
      {open && (
        <div className="min-w-0 border-t border-border/50 font-mono text-xs">
          <HighlightedDiffFile file={file} wrap stickyHeader={false} />
        </div>
      )}
    </div>
  )
}

/** Última mensagem de assistente com snapshot (qualquer sessão code) */
function useLastCodeMessage(): { sessionId: string; message: ChatMessage } | null {
  const sessions = useSessionStore((s) => s.sessions)
  const allMessages = useSessionStore((s) => s.messages)
  return useMemo(() => {
    const codeSessions = sessions
      .filter((s) => s.mode === "code")
      .sort((a, b) => b.updatedAt - a.updatedAt)
    for (const session of codeSessions) {
      const msgs = allMessages[session.id]
      if (!msgs) continue
      const found = [...msgs].reverse().find((m) => m.role === "assistant" && m.snapshot?.patch)
      if (found) return { sessionId: session.id, message: found }
    }
    return null
  }, [sessions, allMessages])
}

/**
 * Aba Diff: mostra o patch de uma mensagem do chat OU de uma task da esteira.
 * As duas fontes existem porque a esteira não cria mensagens (D12) — o patch
 * dela é medido pelo engine e vive na própria task.
 */
export function DiffTab({ sessionId, messageId, esteiraId, taskId }: {
  sessionId?: string
  messageId?: string
  esteiraId?: string
  taskId?: string
}) {
  const { t } = useTranslation()
  const auto = useLastCodeMessage()
  const daEsteira = !!(esteiraId && taskId)
  const resolvedSessionId = daEsteira ? "" : sessionId ?? auto?.sessionId ?? ""
  const resolvedMessageId = daEsteira ? "" : messageId ?? auto?.message.id ?? ""

  const messages = useSessionStore((s) => s.messages[resolvedSessionId])
  const message: ChatMessage | undefined = useMemo(
    () => messages?.find((m) => m.id === resolvedMessageId),
    [messages, resolvedMessageId],
  )

  const task = useEsteiraStore((s) =>
    esteiraId && taskId ? (s.tasksPorEsteira[esteiraId] ?? SEM_TASKS).find((x) => x.id === taskId) : undefined,
  )

  const patch = daEsteira ? task?.diff?.patch : message?.snapshot?.patch
  const totalArquivos = daEsteira ? task?.diff?.arquivos?.length : message?.snapshot?.files?.length

  const files = useMemo(() => (patch ? parsePatch(patch) : null), [patch])

  const session = useSessionStore((s) => s.sessions.find((s) => s.id === resolvedSessionId))
  const isAuto = !daEsteira && !sessionId

  if (daEsteira ? !task : !message) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("diff.noChanges")}
      </div>
    )
  }

  if (!files || files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("diff.noChangesInMessage")}
      </div>
    )
  }

  const totalAdded = files.reduce((s, f) => s + f.added, 0)
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
        {isAuto && session && (
          <span className="truncate font-medium text-foreground">{session.title}</span>
        )}
        <span>{t("diff.filesCount", { count: totalArquivos ?? files.length })}</span>
        {totalAdded > 0 && <span className="text-emerald-500">+{totalAdded}</span>}
        {totalRemoved > 0 && <span className="text-red-500">-{totalRemoved}</span>}
      </div>
      <div className="flex-1 overflow-y-auto pr-0.5">
        {files.map((file, i) => (
          <FileDiffSection key={i} file={file} />
        ))}
      </div>
    </div>
  )
}
