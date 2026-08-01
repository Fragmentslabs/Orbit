import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Folder, Plus, X } from "lucide-react"

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
  compact?: boolean
}

export function FolderSelector({ folders, onFoldersChange, compact }: FolderSelectorProps) {
  const { t } = useTranslation()
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

  const setPrimaryFolder = useCallback(async (path?: string) => {
    if (compact) return
    let folderPath: string | undefined = path
    if (!folderPath) {
      const picked = await pickFolder()
      if (!picked) return
      folderPath = picked
    }
    setRecentOpen(false)
    if (folders[0] === folderPath) return
    onFoldersChange([folderPath, ...folders.slice(1)])
  }, [folders, onFoldersChange, compact])

  const addAdditionalFolder = useCallback(async () => {
    const picked = await pickFolder()
    if (!picked || folders.includes(picked)) return
    onFoldersChange([...folders, picked])
  }, [folders, onFoldersChange])

  const removeFolder = useCallback((path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onFoldersChange(folders.filter(f => f !== path))
  }, [folders, onFoldersChange])

  const getFolderName = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/")
    return parts[parts.length - 1] || path
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {compact ? (
        <span className="flex h-7 items-center gap-1 rounded-md border border-border/50 px-2 text-xs font-medium text-muted-foreground">
          <Folder className="size-3 shrink-0" />
          <span className="truncate max-w-24">{getFolderName(folders[0])}</span>
        </span>
      ) : (
        <div className="relative" ref={recentRef}>
          <button
            onClick={() => setRecentOpen(v => !v)}
            className="group relative flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
          >
            <div className="relative size-5 shrink-0">
              <div className="absolute inset-0 flex size-5 items-center justify-center overflow-hidden rounded">
                <Folder className="size-3 text-sidebar-foreground/60" />
              </div>
            </div>
            <span className="flex-1 truncate">
              {folders.length === 0 ? t("folderSelector.associate") : getFolderName(folders[0])}
            </span>
          </button>
          {recentOpen && (
            <div className="absolute bottom-full left-0 mb-1 z-50 w-56 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
              {recentFolders.length > 0 && (
                <div className="mb-1 border-b border-border pb-1">
                  <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {t("folderSelector.recent")}
                  </p>
                  {recentFolders.map((folder) => (
                    <button
                      key={folder}
                      onClick={() => setPrimaryFolder(folder)}
                      className="flex w-full min-h-7 items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
                    >
                      <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
                      <span className="truncate">{getFolderName(folder)}</span>
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => setPrimaryFolder()}
                className="flex w-full min-h-7 items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
              >
                <Folder className="size-3.5" />
                {t("folderSelector.newFolder")}
              </button>
            </div>
          )}
        </div>
      )}
      {folders.slice(1).map((folder) => {
        const btnClass = compact
          ? "group relative flex h-7 cursor-default select-none items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
          : "group relative flex h-8 cursor-default select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
        return (
          <div key={folder} className={btnClass}>
            <div className="relative size-4 shrink-0">
              <div className="absolute inset-0 flex size-4 items-center justify-center overflow-hidden rounded text-sidebar-foreground/60 transition-opacity group-hover:opacity-0">
                <Folder className="size-2.5" />
              </div>
              <button
                onClick={(e) => removeFolder(folder, e)}
                className="absolute inset-0 flex size-4 cursor-pointer items-center justify-center rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-foreground/10"
              >
                <X className="size-2" />
                <span className="sr-only">{t("folderSelector.remove")}</span>
              </button>
            </div>
            <span className="flex-1 truncate max-w-24">{getFolderName(folder)}</span>
          </div>
        )
      })}
      {folders.length > 0 && (
        <button
          onClick={() => addAdditionalFolder()}
          className={compact
            ? "group relative flex h-7 cursor-pointer select-none items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
            : "group relative flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
          }
        >
          <div className="relative size-4 shrink-0">
            <div className="absolute inset-0 flex size-4 items-center justify-center overflow-hidden rounded">
              <Plus className="size-2.5" />
            </div>
          </div>
        </button>
      )}
    </div>
  )
}
