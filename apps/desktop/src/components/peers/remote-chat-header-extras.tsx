import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Archive, ArchiveRestore, Ellipsis, Folder, GitBranch, Pencil, Pin, PinOff, Trash2 } from "lucide-react"
import type { SessionInfo } from "@shared/chat"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { RenameDialog } from "@/src/components/chat-header"
import { useRemoteSessionActions } from "@/src/hooks/use-remote-session-actions"
import { folderLabel } from "@/src/lib/folder-label"
import { peersApi } from "@/src/lib/ipc"

/** Current branch of the chat's working folder on the paired desktop; null while unknown. */
function useRemoteBranch(peerId: string, directory: string | undefined, enabled: boolean): string | null {
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    setBranch(null)
    if (!directory || !enabled) return
    let alive = true
    peersApi
      .request<{ current: string }>(peerId, { type: "git:branches", directory })
      .then((res) => alive && setBranch(res?.current || null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [peerId, directory, enabled])
  return branch
}

/**
 * What a chat of another desktop adds to the header: its working folders and branch (read-only
 * — they belong to that machine) and the chat menu. The menu needs the peer's `control` grant,
 * the same one the sidebar rows ask for.
 */
export function RemoteChatHeaderExtras({ peerId, session }: { peerId: string; session: SessionInfo }) {
  const { t } = useTranslation()
  const { canAct, togglePin, toggleArchive, rename, remove } = useRemoteSessionActions(peerId, session)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const folders = session.directory ? [session.directory, ...(session.extraDirectories ?? [])] : []
  const branch = useRemoteBranch(peerId, session.mode === "code" ? session.directory : undefined, canAct)

  return (
    <>
      {folders.length > 0 || branch ? (
        <div className="hidden min-w-0 items-center gap-1 @xl:flex" title={folders.join("\n")}>
          {branch ? <Chip icon={<GitBranch className="size-3" />} label={branch} /> : null}
          {folders.slice(0, 3).map((folder) => (
            <Chip key={folder} icon={<Folder className="size-3" />} label={folderLabel(folder)} />
          ))}
          {folders.length > 3 ? <span className="text-[11px] text-muted-foreground">+{folders.length - 3}</span> : null}
        </div>
      ) : null}
      {canAct ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-6 shrink-0" />}>
              <Ellipsis className="size-3.5" />
              <span className="sr-only">{t("header.options")}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onClick={togglePin}>
                {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                {session.pinned ? t("sidebar.session.unpin") : t("header.pin")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <Pencil className="size-4" />
                {t("header.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleArchive}>
                {session.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                {session.archived ? t("sidebar.session.unarchive") : t("header.archive")}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" />
                {t("header.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <RenameDialog open={renaming} onOpenChange={setRenaming} initialValue={session.title} onSubmit={rename} />
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={t("sidebar.session.deleteTitle")}
            description={t("sidebar.session.deleteDescription", { title: session.title || "…" })}
            confirmLabel={t("sidebar.session.confirmDelete")}
            destructive
            onConfirm={remove}
          />
        </>
      ) : null}
    </>
  )
}

function Chip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex min-w-0 max-w-32 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {icon}
      <span className="truncate">{label}</span>
    </span>
  )
}
