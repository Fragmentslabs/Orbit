import { useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, Folder, FolderGit2, GitBranch } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector, getFolderName, useMainFolderName } from "@/src/components/folder-selector"
import { useCurrentWorktreeLabel, WorktreeSelector } from "@/src/components/worktree-selector"
import { useBranchStore } from "@/src/stores/branch-store"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Compact version of branch + folders for narrow containers (@container):
 * a single button that opens a menu with two shortcuts ("Branch" and "Folders"),
 * each one opening the full dropdown of the respective component (controlled
 * via open/onOpenChange/hideTrigger) anchored in this same wrapper.
 */
export function CompactWorkspaceSelector({
  repoPath,
  folders,
  onFoldersChange,
  onRequestAgentAction,
  suggestedWorktreeName,
}: {
  repoPath?: string
  folders: string[]
  onFoldersChange: (folders: string[]) => void
  onRequestAgentAction?: (instruction: string) => void
  /** Name suggestion for a new worktree (chat title) */
  suggestedWorktreeName?: string
}) {
  const { t } = useTranslation()
  const byDir = useBranchStore((s) => (repoPath ? s.byDir[repoPath] : undefined))
  const hasBranches = !!byDir && byDir.branches.length > 0

  const [menuOpen, setMenuOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [worktreeOpen, setWorktreeOpen] = useState(false)
  // Null outside a git repository: the worktree shortcut disappears from the menu.
  const currentWorktree = useCurrentWorktreeLabel(folders[0])
  const mainName = useMainFolderName(folders[0])

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
          
            <Truncate>
                <span className="truncate">{folders.length === 0 ? t("folderSelector.associate") : mainName}</span>
            </Truncate>
          {/* The compact button only shows the main folder: the counter tells
              how many attached folders were left out (hover lists the names). */}
          {folders.length > 1 && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-muted-foreground"
              title={folders.slice(1).map(getFolderName).join(" · ")}
            >
              <span className="size-1 rounded-full bg-current" aria-hidden />
              {folders.length - 1}
              <span className="sr-only">{t("folderSelector.others")}</span>
            </span>
          )}
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
                {/* max-w-16 cuts almost any real branch name here */}
                
                  <Truncate>
                      <span className="max-w-16 truncate" title={byDir?.current}>{byDir?.current}</span>
                  </Truncate>
                <ChevronRight className="size-3" />
              </span>
            </DropdownMenuItem>
          )}
          {folders[0] && currentWorktree && (
            <DropdownMenuItem onClick={() => setWorktreeOpen(true)} className="justify-between">
              <span className="flex items-center gap-2">
                <FolderGit2 className="size-3.5" />
                {t("worktree.title")}
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                
                  <Truncate>
                      <span className="max-w-16 truncate" title={currentWorktree}>{currentWorktree}</span>
                  </Truncate>
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
      {folders[0] && (
        <WorktreeSelector
          folder={folders[0]}
          onSwitch={(folder) => onFoldersChange([folder, ...folders.slice(1)])}
          suggestedName={suggestedWorktreeName}
          open={worktreeOpen}
          onOpenChange={setWorktreeOpen}
          hideTrigger
        />
      )}
      <FolderSelector folders={folders} onFoldersChange={onFoldersChange} open={folderOpen} onOpenChange={setFolderOpen} hideTrigger compact />
    </div>
  )
}
