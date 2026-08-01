import { Archive, Ellipsis, PanelLeft, PanelRightClose, PanelRightOpen, Pencil, Pin, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector } from "@/src/components/folder-selector"

interface ChatHeaderProps {
  title?: string
  hasMenu?: boolean
  rightPanelOpen?: boolean
  onToggleSidebar?: () => void
  onToggleRightPanel?: () => void
  repoPath?: string
  workspaceMode?: 'chat' | 'code'
  onRequestAgentAction?: (instruction: string) => void
  folders?: string[]
  onFoldersChange?: (folders: string[]) => void
}

export function ChatHeader({ title, hasMenu, rightPanelOpen, onToggleSidebar, onToggleRightPanel, repoPath, workspaceMode, onRequestAgentAction, folders, onFoldersChange }: ChatHeaderProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="flex h-12 items-center gap-2 px-4">
      {onToggleSidebar && (
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={onToggleSidebar}>
          <PanelLeft className="size-4" />
          <span className="sr-only">{t("header.toggleSidebar")}</span>
        </Button>
      )}
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <span className="truncate text-sm font-medium text-foreground">{title ?? t("header.newChat")}</span>
        {workspaceMode === 'code' && repoPath && <BranchSelector repoPath={repoPath} onRequestAgentAction={onRequestAgentAction} />}
        {workspaceMode === 'code' && folders && folders.length > 0 && onFoldersChange && (
          <FolderSelector folders={folders} onFoldersChange={onFoldersChange} compact />
        )}
        {hasMenu && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-6 shrink-0" />}>
              <Ellipsis className="size-3.5" />
              <span className="sr-only">{t("header.options")}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuItem>
                <Pin className="size-4" />
                {t("header.pin")}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Pencil className="size-4" />
                {t("header.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Archive className="size-4" />
                {t("header.archive")}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Trash2 className="size-4" />
                {t("header.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {onToggleRightPanel && (
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={onToggleRightPanel}>
          {rightPanelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          <span className="sr-only">{t("header.togglePanel")}</span>
        </Button>
      )}
    </div>
  )
}
