import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronDown, Folder, Plus, X } from "lucide-react"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function loadRecentFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    return []
  }
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

  const folderMenu = recentOpen && (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
      <button
        onClick={() => addAdditionalFolder()}
        className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs font-medium hover:bg-foreground/10"
      >
        <Plus className="size-3.5" />
        {t("folderSelector.newFolder")}
      </button>
      {(recentFolders.length > 0 || folders.length > 0) && <div className="my-1 border-t border-border" />}
      {recentFolders.map((folder) => {
        const active = folders[0] === folder
        return (
          <button
            key={folder}
            onClick={() => setPrimaryFolder(folder)}
            className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
          >
            <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
            <span className="truncate">{getFolderName(folder)}</span>
            {active && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
          </button>
        )
      })}
      {folders.map((folder) => {
        if (recentFolders.includes(folder)) return null
        return (
          <button
            key={folder}
            onClick={() => setPrimaryFolder(folder)}
            className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/10"
          >
            <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
            <span className="truncate">{getFolderName(folder)}</span>
            {folders[0] === folder && <Check className="ml-auto size-3.5 shrink-0 text-primary" />}
          </button>
        )
      })}
    </div>
  )

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <div className="relative min-w-0" ref={recentRef}>
        <button
          onClick={() => setRecentOpen(v => !v)}
          className={compact
            ? "group flex h-7 min-w-0 max-w-28 cursor-pointer select-none items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 sm:max-w-40"
            : "group flex h-8 min-w-0 max-w-40 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm font-medium transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
          }
        >
          <Folder className="size-3 shrink-0 text-sidebar-foreground/60" />
          <span className="truncate">{folders.length === 0 ? t("folderSelector.associate") : getFolderName(folders[0])}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
        {folderMenu}
      </div>
      <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
        {folders.slice(1).map((folder) => {
          const btnClass = compact
            ? "group relative flex h-7 max-w-28 cursor-default select-none items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 sm:max-w-40"
            : "group relative flex h-8 max-w-40 cursor-default select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm font-medium transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50"
          return (
            <div key={folder} className={btnClass}>
              <Folder className="size-2.5 shrink-0 text-sidebar-foreground/60" />
              <span className="truncate">{getFolderName(folder)}</span>
              <button onClick={(e) => removeFolder(folder, e)} className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded opacity-60 hover:bg-foreground/10 hover:opacity-100">
                <X className="size-2" />
                <span className="sr-only">{t("folderSelector.remove")}</span>
              </button>
            </div>
          )
        })}
        {folders.length > 0 && (
          <button onClick={() => addAdditionalFolder()} className={compact ? "flex h-7 size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/50 text-xs hover:bg-accent" : "flex h-8 size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-sm hover:bg-accent"}>
            <Plus className="size-2.5" />
          </button>
        )}
      </div>
    </div>
  )
}
