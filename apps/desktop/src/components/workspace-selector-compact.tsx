import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, Folder, GitBranch } from "lucide-react"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector, getFolderName } from "@/src/components/folder-selector"
import { useBranchStore } from "@/src/stores/branch-store"

/**
 * Versão compacta de branch + pastas para containers estreitos (@container):
 * um único botão que abre um menu com dois atalhos ("Branch" e "Pastas"),
 * cada um abrindo o dropdown completo do respectivo componente (controlado
 * via open/onOpenChange/hideTrigger) ancorado neste mesmo wrapper.
 */
export function CompactWorkspaceSelector({
  repoPath,
  folders,
  onFoldersChange,
  onRequestAgentAction,
}: {
  repoPath?: string
  folders: string[]
  onFoldersChange: (folders: string[]) => void
  onRequestAgentAction?: (instruction: string) => void
}) {
  const { t } = useTranslation()
  const byDir = useBranchStore((s) => (repoPath ? s.byDir[repoPath] : undefined))
  const hasBranches = !!byDir && byDir.branches.length > 0

  const [menuOpen, setMenuOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [menuOpen])

  if (!repoPath && folders.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex h-7 min-w-0 max-w-32 items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Folder className="size-3 shrink-0 text-sidebar-foreground/60" />
        <span className="truncate">{folders.length === 0 ? t("folderSelector.associate") : getFolderName(folders[0])}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>

      {menuOpen && (
        <div className="absolute left-0 top-full z-[60] mt-1 w-48 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
          {repoPath && hasBranches && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                setBranchOpen(true)
              }}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-foreground/10"
            >
              <span className="flex items-center gap-2">
                <GitBranch className="size-3.5" />
                {t("branch.title")}
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="max-w-16 truncate">{byDir?.current}</span>
                <ChevronRight className="size-3" />
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false)
              setFolderOpen(true)
            }}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-foreground/10"
          >
            <span className="flex items-center gap-2">
              <Folder className="size-3.5" />
              {t("folderSelector.title")}
            </span>
            <ChevronRight className="size-3 text-muted-foreground" />
          </button>
        </div>
      )}

      {repoPath && (
        <BranchSelector
          repoPath={repoPath}
          onRequestAgentAction={onRequestAgentAction}
          open={branchOpen}
          onOpenChange={setBranchOpen}
          hideTrigger
        />
      )}
      <FolderSelector folders={folders} onFoldersChange={onFoldersChange} open={folderOpen} onOpenChange={setFolderOpen} hideTrigger compact />
    </div>
  )
}
