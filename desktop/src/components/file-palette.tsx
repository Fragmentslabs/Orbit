import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { FileIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { normalizeText } from "@shared/memory"
import { usePromptInputController, usePromptInputAttachments } from "@/src/components/ai/prompt-input"

const MAX_FILES = 2000

function matches(filePath: string, query: string): boolean {
  if (!query) return true
  const haystack = normalizeText(filePath.replace(/[/\\]/g, "/"))
  return query.split(" ").every((token) => haystack.includes(token))
}

export function FilePalette({ directory, children }: {
  directory?: string
  children: ReactNode
}) {
  const controller = usePromptInputController()
  const attachments = usePromptInputAttachments()
  const value = controller.textInput.value

  const open = value.startsWith("@") && directory != null
  const query = open ? normalizeText(value.slice(1)) : ""

  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const loadedDir = useRef<string | undefined>()
  const baseDir = useMemo(() => directory?.replace(/\\/g, "/") ?? "", [directory])

  useEffect(() => {
    if (!open || !directory) return
    if (loadedDir.current === directory) return
    loadedDir.current = directory
    setLoading(true)
    window.ipcRenderer
      .invoke("fs:listFilesRecursive", directory)
      .then((result: unknown) => {
        const r = result as { ok: true; files: string[] } | { ok: false; error: string }
        if (r.ok) {
          setFiles(r.files.slice(0, MAX_FILES))
        }
      })
      .finally(() => setLoading(false))
  }, [open, directory])

  const filtered = useMemo(() => {
    if (!open) return []
    return files.filter((f) => matches(f, query))
  }, [files, open, query])

  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    setHighlight(0)
  }, [query, open])

  const select = async (relPath: string) => {
    if (!directory) return
    const fullPath = `${baseDir}/${relPath}`
    const result = await window.ipcRenderer
      .invoke("fs:readFileAsDataUrl", fullPath)
      .then((r: unknown) => r as { dataUrl: string } | { error: string })
    if ("error" in result) return
    const response = await fetch(result.dataUrl)
    const blob = await response.blob()
    const filename = relPath.split("/").pop() ?? relPath
    const file = new File([blob], filename, { type: blob.type })
    attachments.add([file])
    controller.textInput.clear()
  }

  const handleKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open || filtered.length === 0) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      e.stopPropagation()
      setHighlight((h) => {
        const delta = e.key === "ArrowDown" ? 1 : -1
        return (h + delta + filtered.length) % filtered.length
      })
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      e.stopPropagation()
      select(filtered[Math.min(highlight, filtered.length - 1)])
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      controller.textInput.clear()
    }
  }

  return (
    <div className="relative" onKeyDownCapture={handleKeyDownCapture}>
      {open && (filtered.length > 0 || loading) && (
        <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-80 overflow-y-auto rounded-xl border-2 border-sidebar-border bg-popover p-1.5 text-popover-foreground shadow-lg">
          <p className="flex items-center gap-1 px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <FileIcon className="size-3" /> Arquivos
          </p>
          {loading && (
            <p className="px-2 py-2 text-xs text-muted-foreground">Carregando...</p>
          )}
          {!loading && filtered.map((relPath) => {
            const index = filtered.indexOf(relPath)
            const filename = relPath.split("/").pop() ?? relPath
            return (
              <button
                key={relPath}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  index === highlight && "bg-accent text-accent-foreground",
                )}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  select(relPath)
                }}
              >
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium">{filename}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {relPath}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {children}
    </div>
  )
}
