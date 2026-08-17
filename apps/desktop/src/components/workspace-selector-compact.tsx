import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, Folder, GitBranch } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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

  if (!repoPath && folders.length === 0) return null

  return (
    <div className="relative">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex h-7 min-w-0 max-w-32 items-center gap-1 rounded-md border border-border/50 px-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            />
          }
        >
          <Folder className="size-3 shrink-0 text-sidebar-foreground/60" />
          <span className="truncate">{folders.length === 0 ? t("folderSelector.associate") : getFolderName(folders[0])}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 p-1">
          {repoPath && hasBranches && (
            <DropdownMenuItem onClick={() => setBranchOpen(true)} className="justify-between">
              <span className="flex items-center gap-2">
                <GitBranch className="size-3.5" />
                {t("branch.title")}
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="max-w-16 truncate">{byDir?.current}</span>
                <ChevronRight className="size-3" />
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setFolderOpen(true)} className="justify-between">
            <span className="flex items-center gap-2">
              <Folder className="size-3.5" />
              {t("folderSelector.title")}
            </span>
            <ChevronRight className="size-3 text-muted-foreground" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
