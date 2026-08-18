import { Archive, ArchiveRestore, Ellipsis, PanelLeft, PanelRightClose, PanelRightOpen, Pencil, Pin, PinOff, Search, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { SessionInfo } from "@shared/chat"
import { BranchSelector } from "@/src/components/branch-selector"
import { BrowserTestChip } from "@/src/components/browser-test-chip"
import { FolderSelector } from "@/src/components/folder-selector"
import { CompactWorkspaceSelector } from "@/src/components/workspace-selector-compact"
import { useSessionStore } from "@/src/stores/session-store"
import { useChatSearchStore } from "@/src/stores/chat-search-store"

interface ChatHeaderProps {
  title?: string
  hasMenu?: boolean
  session?: SessionInfo
  /** Sessão ativa (chat ou código) — para o indicador de browser do agente. */
  sessionId?: string
  rightPanelOpen?: boolean
  onToggleSidebar?: () => void
  onToggleRightPanel?: () => void
  repoPath?: string
  workspaceMode?: 'chat' | 'code'
  onRequestAgentAction?: (instruction: string) => void
  folders?: string[]
  onFoldersChange?: (folders: string[]) => void
  /** Conteúdo extra à esquerda do botão do painel (ex.: modelo da esteira) */
  extra?: React.ReactNode
}

function RenameDialog({ open, onOpenChange, initialValue, onSubmit }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialValue: string
  onSubmit: (value: string) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) setValue(initialValue); onOpenChange(next) }}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("sidebar.session.renameTitle")}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit}>{t("sidebar.session.rename")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ChatHeader({ title, hasMenu, session, sessionId, rightPanelOpen, onToggleSidebar, onToggleRightPanel, repoPath, workspaceMode, onRequestAgentAction, folders, onFoldersChange, extra }: ChatHeaderProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const toggleChatSearch = useChatSearchStore((s) => s.toggle)

  return (
    // O `@container` da raiz mede a largura real do header (que encolhe com a
    // sidebar e o painel direito abertos, sem o viewport mudar) — é o que o
    // chip do browser usa para decidir entre ícone+texto e só o ícone. Como
    // container cria stacking context, o `relative z-20` tem que vir junto:
    // sem ele o degrade do topo do chat (z-10, num irmão posterior) passaria
    // por cima do header inteiro.
    <div className="@container relative z-20 flex h-12 items-center gap-2 px-4">
      {onToggleSidebar && (
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={onToggleSidebar}>
          <PanelLeft className="size-4" />
          <span className="sr-only">{t("header.toggleSidebar")}</span>
        </Button>
      )}
      {/* `@container` aplica layout containment, que cria um stacking context:
          sem um z-index explícito aqui, o z-[60] do dropdown de pastas fica
          preso dentro dele e o degrade do topo do chat (z-10, num irmão
          posterior) passa por cima do header inteiro. */}
      <div className="@container relative z-20 flex items-center gap-1 min-w-0 flex-1">
        <span className="truncate text-sm font-medium text-foreground">{title ?? t("header.newChat")}</span>
        {workspaceMode === 'code' && (
          <>
            <div className="hidden min-w-0 items-center gap-1 @xl:flex">
              {repoPath && <BranchSelector repoPath={repoPath} onRequestAgentAction={onRequestAgentAction} />}
              {folders && folders.length > 0 && onFoldersChange && (
                <FolderSelector folders={folders} onFoldersChange={onFoldersChange} compact />
              )}
            </div>
            {(repoPath || (folders && folders.length > 0)) && onFoldersChange && (
              <div className="flex min-w-0 items-center @xl:hidden">
                <CompactWorkspaceSelector
                  repoPath={repoPath}
                  folders={folders ?? []}
                  onFoldersChange={onFoldersChange}
                  onRequestAgentAction={onRequestAgentAction}
                />
              </div>
            )}
          </>
        )}
        {hasMenu && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-6 shrink-0" />}>
              <Ellipsis className="size-3.5" />
              <span className="sr-only">{t("header.options")}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuItem onClick={() => toggleChatSearch()}>
                <Search className="size-4" />
                {t("header.searchInChat")}
              </DropdownMenuItem>
              {session && (
                <>
                  <DropdownMenuItem onClick={() => useSessionStore.getState().togglePin(session.id)}>
                    {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                    {session.pinned ? t("sidebar.session.unpin") : t("header.pin")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRenaming(true)}>
                    <Pencil className="size-4" />
                    {t("header.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => useSessionStore.getState().toggleArchive(session.id)}>
                    {session.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                    {session.archived ? t("sidebar.session.unarchive") : t("header.archive")}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="size-4" />
                    {t("header.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {extra}
      {sessionId && <BrowserTestChip sessionId={sessionId} compact className="self-center" />}
      {onToggleRightPanel && (
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={onToggleRightPanel}>
          {rightPanelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          <span className="sr-only">{t("header.togglePanel")}</span>
        </Button>
      )}
      {session && (
        <>
          <RenameDialog
            open={renaming}
            onOpenChange={setRenaming}
            initialValue={session.title}
            onSubmit={(value) => useSessionStore.getState().renameSession(session.id, value)}
          />
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={t("sidebar.session.deleteTitle")}
            description={t("sidebar.session.deleteDescription", { title: session.title })}
            confirmLabel={t("sidebar.session.confirmDelete")}
            destructive
            onConfirm={() => void useSessionStore.getState().deleteSession(session.id)}
          />
        </>
      )}
    </div>
  )
}
