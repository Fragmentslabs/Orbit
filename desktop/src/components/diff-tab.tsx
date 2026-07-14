import { useMemo } from "react"
import type { ChatMessage } from "@shared/chat"
import { useSessionStore } from "@/src/stores/session-store"
import { cn } from "@/lib/utils"

/** Parseia um unified diff em hunks com metadados por arquivo. */
interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header: string
  lines: Array<{ kind: "add" | "del" | "ctx"; text: string }>
}

interface FileDiff {
  oldPath: string
  newPath: string
  hunks: Hunk[]
  added: number
  removed: number
}

function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  const fileBlocks = patch.split(/(?=^diff --git )/m)

  for (const block of fileBlocks) {
    if (!block.trim()) continue
    const headerMatch = block.match(/^diff --git a\/(.+?) b\/(.+?)$/m)
    if (!headerMatch) continue

    const oldPath = headerMatch[1]
    const newPath = headerMatch[2]
    const hunks: Hunk[] = []
    let added = 0
    let removed = 0

    const hunkBlocks = block.split(/(?=^@@ )/m)
    for (const hunkBlock of hunkBlocks) {
      const hunkMatch = hunkBlock.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.+)?$/m)
      if (!hunkMatch) continue

      const oldStart = Number(hunkMatch[1])
      const oldLines = Number(hunkMatch[2] || 1)
      const newStart = Number(hunkMatch[3])
      const newLines = Number(hunkMatch[4] || 1)
      const header = (hunkMatch[5] ?? "").trim()

      const lines: Hunk["lines"] = []
      const bodyLines = hunkBlock.split("\n").slice(1) // skip @@ line
      for (const raw of bodyLines) {
        const line = raw.replace(/\r$/, "")
        if (line.startsWith("+")) {
          lines.push({ kind: "add", text: line.slice(1) })
          added++
        } else if (line.startsWith("-")) {
          lines.push({ kind: "del", text: line.slice(1) })
          removed++
        } else {
          lines.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line })
        }
      }

      hunks.push({ oldStart, oldLines, newStart, newLines, header, lines })
    }

    files.push({ oldPath, newPath, hunks, added, removed })
  }

  return files
}

function FileDiffSection({ file }: { file: FileDiff }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 rounded-t-md bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="truncate">{file.oldPath === file.newPath ? file.oldPath : `${file.oldPath} → ${file.newPath}`}</span>
        <span className="ml-auto flex items-center gap-2 text-[11px]">
          {file.added > 0 && <span className="text-emerald-500">+{file.added}</span>}
          {file.removed > 0 && <span className="text-red-500">-{file.removed}</span>}
        </span>
      </div>
      {file.hunks.map((hunk, hi) => {
        let oldLine = hunk.oldStart
        let newLine = hunk.newStart
        return (
          <div key={hi} className="border-x border-border/50">
            <div className="bg-accent/30 px-3 py-1 font-mono text-[11px] text-muted-foreground">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header && ` ${hunk.header}`}
            </div>
            {hunk.lines.map((line, li) => {
              const lineNum = line.kind === "add" ? `  ${newLine}` : line.kind === "del" ? `${oldLine}  ` : `${oldLine} →${newLine}`
              if (line.kind !== "del") newLine++
              if (line.kind !== "add") oldLine++
              return (
                <div
                  key={li}
                  className={cn(
                    "flex font-mono text-[11px] leading-relaxed",
                    line.kind === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                    line.kind === "del" && "bg-red-500/10 text-red-700 dark:text-red-400",
                  )}
                >
                  <span className="w-14 shrink-0 select-none text-right text-[10px] text-muted-foreground/40 tabular-nums">
                    {lineNum}
                  </span>
                  <span className="w-4 shrink-0 select-none text-center text-muted-foreground/50">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-all px-1">{line.text}</span>
                </div>
              )
            })}
          </div>
        )
      })}
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

export function DiffTab({ sessionId, messageId }: {
  sessionId?: string
  messageId?: string
}) {
  const auto = useLastCodeMessage()
  const resolvedSessionId = sessionId ?? auto?.sessionId ?? ""
  const resolvedMessageId = messageId ?? auto?.message.id ?? ""

  const messages = useSessionStore((s) => s.messages[resolvedSessionId])
  const message: ChatMessage | undefined = useMemo(
    () => messages?.find((m) => m.id === resolvedMessageId),
    [messages, resolvedMessageId],
  )

  const files = useMemo(() => {
    if (!message?.snapshot?.patch) return null
    return parsePatch(message.snapshot.patch)
  }, [message])

  if (!message) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Nenhuma alteração encontrada
      </div>
    )
  }

  if (!files || files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Nenhuma alteração nesta mensagem
      </div>
    )
  }

  const isAuto = !sessionId
  const session = useSessionStore((s) => s.sessions.find((s) => s.id === resolvedSessionId))
  const totalAdded = files.reduce((s, f) => s + f.added, 0)
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
        {isAuto && session && (
          <span className="truncate font-medium text-foreground">{session.title}</span>
        )}
        <span>{message.snapshot!.files?.length ?? files.length} arquivo{(message.snapshot!.files?.length ?? files.length) !== 1 ? "s" : ""}</span>
        {totalAdded > 0 && <span className="text-emerald-500">+{totalAdded}</span>}
        {totalRemoved > 0 && <span className="text-red-500">-{totalRemoved}</span>}
      </div>
      <div className="flex-1 overflow-y-auto rounded-lg border border-border/50">
        {files.map((file, i) => (
          <FileDiffSection key={i} file={file} />
        ))}
      </div>
    </div>
  )
}
