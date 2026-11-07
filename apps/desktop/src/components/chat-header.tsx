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
import { WorktreeSelector } from "@/src/components/worktree-selector"
import { DeleteChatDialog } from "@/src/components/delete-chat-dialog"
import { BrowserTestChip } from "@/src/components/browser-test-chip"
import { ComputerChip } from "@/src/components/computer-chip"
import { VoiceCallBadge } from "@/src/components/voice-call-badge"
import { FolderSelector } from "@/src/components/folder-selector"
import { CompactWorkspaceSelector } from "@/src/components/workspace-selector-compact"
import { useSessionStore } from "@/src/stores/session-store"
import { useChatSearchStore } from "@/src/stores/chat-search-store"
import { Truncate } from "@/components/ui/truncated-text"
import { AgentSelector } from "@/src/components/agent-selector"

interface ChatHeaderProps {
  title?: string
  /** Replaces the plain title (a page that needs more than text there, e.g. a fragment's back/icon/name). */
  titleSlot?: React.ReactNode
  hasMenu?: boolean
  /** Shows which agent the conversation runs with (only on the chat view). */
  showAgent?: boolean
  session?: SessionInfo
  /** Active session (chat or code) — for the agent browser indicator. */
  sessionId?: string
  rightPanelOpen?: boolean
  onToggleSidebar?: () => void
  onToggleRightPanel?: () => void
  repoPath?: string
  workspaceMode?: 'chat' | 'code'
  onRequestAgentAction?: (instruction: string) => void
  folders?: string[]
  onFoldersChange?: (folders: string[]) => void
  /** Extra content to the left of the panel button (e.g. the pipeline model) */
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

export function ChatHeader({ title, titleSlot, hasMenu, showAgent, session, sessionId, rightPanelOpen, onToggleSidebar, onToggleRightPanel, repoPath, workspaceMode, onRequestAgentAction, folders, onFoldersChange, extra }: ChatHeaderProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const toggleChatSearch = useChatSearchStore((s) => s.toggle)
  // With 4+ folders the chips of inline mode do not fit reliably in
  // any width: with the sidebar and the right panel open, the ruler of
  // folders breaks even above `@5xl` (64rem = 1024px) — raising the threshold
  // would only push the problem to larger screens. So >3 folders goes straight
  // to the compact dropdown, at any width, without waiting for the container
  // query. With up to 3 folders (3 folders + branch + title ≈ 750-800px;
  // `@xl` = 36rem) the inline mode still holds from `@xl` up.
  const manyFolders = (folders?.length ?? 0) > 3

  return (
    // The root `@container` measures the real width of the header (which shrinks with the
    // sidebar and the right panel open, without the viewport changing) — it is what the
    // browser chip uses to decide between icon+text and icon only. Since
    // container creates a stacking context, the explicit z-index has to come along:
    // without it the gradient at the top of the chat (z-10, in a later sibling) would pass
    // over the whole header.
    //
    // z-50 and not z-20: the persona at the top of the chat is `absolute z-40` in a later
    // sibling, so with z-20 it stayed over the header — and the folders
    // dropdown, trapped in the @container stacking context, opened below it.
    //
    // The top padding (pt-2.5) puts the title on the same line as the Chat/Code tabs of the
    // sidebar, which start below the floating sidebar's own padding.
    <div className="@container relative z-50 flex h-[58px] items-center gap-2 px-4 pt-2.5">
      {onToggleSidebar && (
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={onToggleSidebar}>
          <PanelLeft className="size-4" />
          <span className="sr-only">{t("header.toggleSidebar")}</span>
        </Button>
      )}
      {/* `@container` applies layout containment, which creates a stacking context:
          without an explicit z-index here, the z-[60] of the folders dropdown stays
          trapped inside it and the gradient at the top of the chat (z-10, in a later
          sibling) passes over the whole header. */}
      <div className="@container relative z-20 flex items-center gap-1 min-w-0 flex-1">
        {titleSlot ?? (
          <Truncate text={title ?? t("header.newChat")}>
            <span className="truncate text-sm font-medium text-foreground">{title ?? t("header.newChat")}</span>
          </Truncate>
        )}
        {workspaceMode === 'code' && (
          <>
            {!manyFolders && (
              <div className="hidden min-w-0 items-center gap-1 @xl:flex">
                {/* Worktree before the branch: it is what defines which branch the
                    chat is on. It only appears in a git repository. */}
                {folders?.[0] && onFoldersChange && (
                  <WorktreeSelector
                    folder={folders[0]}
                    onSwitch={(folder) => onFoldersChange([folder, ...folders.slice(1)])}
                    suggestedName={title}
                  />
                )}
                {repoPath && <BranchSelector repoPath={repoPath} onRequestAgentAction={onRequestAgentAction} />}
                {folders && folders.length > 0 && onFoldersChange && (
                  <FolderSelector folders={folders} onFoldersChange={onFoldersChange} compact />
                )}
              </div>
            )}
            {(repoPath || (folders && folders.length > 0)) && onFoldersChange && (
              <div className={manyFolders ? "flex min-w-0 items-center" : "flex min-w-0 items-center @xl:hidden"}>
                <CompactWorkspaceSelector
                  repoPath={repoPath}
                  folders={folders ?? []}
                  onFoldersChange={onFoldersChange}
                  onRequestAgentAction={onRequestAgentAction}
                  suggestedWorktreeName={title}
                />
              </div>
            )}
          </>
        )}
      </div>
      {extra}
      {/* Which agent the conversation runs with: on the right, in both chat and code. */}
      {showAgent && <AgentSelector session={session} />}
      {sessionId && <BrowserTestChip sessionId={sessionId} compact className="self-center" />}
      {sessionId && <ComputerChip sessionId={sessionId} />}
      {/* Call in progress outside its own conversation: badge in the header (the composer
          panel only exists in the call's own conversation). */}
      <VoiceCallBadge activeSessionId={sessionId} />
      {/* The session menu stays in the right group, next to the panel button:
          outside the elastic stretch, it does not shift with the title nor with the
          folders ruler (which grow and shrink in the middle of the header), and the menu
          opens right-aligned — at the window edge, a menu aligned
          to the left would leak outside. */}
      {hasMenu && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-6 shrink-0" />}>
            <Ellipsis className="size-3.5" />
            <span className="sr-only">{t("header.options")}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
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
          <DeleteChatDialog session={session} open={confirmDelete} onOpenChange={setConfirmDelete} />
        </>
      )}
    </div>
  )
}
