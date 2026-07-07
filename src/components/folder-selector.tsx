import { useCallback, useEffect, useRef, useState } from "react"
import { Folder, X, ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function loadRecentFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {}
  return []
}

async function pickFolder(): Promise<string | null> {
  try {
    const result = await window.ipcRenderer.invoke("select-folder")
    return result as string | null
  } catch {
    return null
  }
}

interface FolderSelectorProps {
  folders: string[]
  onFoldersChange: (folders: string[]) => void
}

export function FolderSelector({ folders, onFoldersChange }: FolderSelectorProps) {
  const [recentOpen, setRecentOpen] = useState(false)
  const recentRef = useRef<HTMLDivElement>(null)
  const [recentFolders] = useState<string[]>(loadRecentFolders)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setRecentOpen(false)
      }
    }
    if (recentOpen) {
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [recentOpen])

  const addFolder = useCallback(async (path?: string) => {
    let folderPath: string | undefined = path
    if (!folderPath) {
      const picked = await pickFolder()
      if (!picked) return
      folderPath = picked
    }
    if (folders.includes(folderPath)) return
    const next = [...folders, folderPath]
    onFoldersChange(next)
    setRecentOpen(false)
  }, [folders, onFoldersChange])

  const removeFolder = useCallback((path: string) => {
    onFoldersChange(folders.filter(f => f !== path))
  }, [folders, onFoldersChange])

  const getFolderName = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/")
    return parts[parts.length - 1] || path
  }

  return (
    <div className="flex flex-wrap items-center gap-2 w-full">
      {folders.map((folder) => (
        <div
          key={folder}
          className="group flex h-8 cursor-default select-none items-center gap-1.5 rounded-md border border-border bg-sidebar-accent/30 px-2 text-sm font-medium transition-colors"
        >
          <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
          <span className="truncate max-w-32">{getFolderName(folder)}</span>
          <button
            onClick={() => removeFolder(folder)}
            className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm opacity-60 transition-opacity hover:opacity-100 hover:bg-foreground/10"
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}
      <div className="relative" ref={recentRef}>
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 text-xs"
          onClick={() => setRecentOpen(v => !v)}
        >
          <Folder className="size-3.5" />
          {folders.length === 0 ? "Associar pasta" : getFolderName(folders[folders.length - 1])}
          <ChevronUp className="size-3" />
        </Button>
        {recentOpen && (
          <div className="absolute bottom-full left-0 mb-1 z-50 w-56 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
            {recentFolders.length > 0 && (
              <div className="mb-1 border-b border-border pb-1">
                <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Recentes
                </p>
                {recentFolders.map((folder) => (
                  <button
                    key={folder}
                    onClick={() => addFolder(folder)}
                    className="flex w-full min-h-7 items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
                  >
                    <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
                    <span className="truncate">{getFolderName(folder)}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => addFolder()}
              className="flex w-full min-h-7 items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
            >
              <Folder className="size-3.5 shrink-0" />
              Nova pasta
            </button>
          </div>
        )}
      </div>
      {folders.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 text-xs"
          onClick={() => addFolder()}
        >
          <Folder className="size-3.5" />
          Adicionar pasta
        </Button>
      )}
    </div>
  )
}
