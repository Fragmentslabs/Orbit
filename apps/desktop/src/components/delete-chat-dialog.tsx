import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { FolderGit2, Loader2Icon } from "lucide-react"
import type { SessionInfo } from "@shared/chat"
import type { WorktreeList, WorktreeInfo } from "@shared/worktrees"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { worktreeApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { useWorktreeStore } from "@/src/stores/worktree-store"

/** The folder is inside (or is) the given root — comparison by path, without touching the disk. */
function isInside(folder: string, root: string): boolean {
  const normalize = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const a = normalize(folder)
  const b = normalize(root)
  return a === b || a.startsWith(`${b}/`)
}

/**
 * Delete a chat. If it was working in a chat-created worktree that no
 * other chat uses, it asks whether the worktree goes along (as Claude Code does when
 * leaving a worktree): the default is to keep it. Removing it with uncommitted
 * changes or commits the main one does not have requires confirming the discard.
 */
export function DeleteChatDialog({
  session,
  open,
  onOpenChange,
}: {
  session: SessionInfo
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [worktree, setWorktree] = useState<{ list: WorktreeList; info: WorktreeInfo } | null>(null)
  const [removeWorktree, setRemoveWorktree] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setWorktree(null)
    setRemoveWorktree(false)
    setDiscard(false)
    setDeleteBranch(false)
    setError(null)
    const folder = session.mode === "code" ? session.directory : undefined
    if (!folder) return
    let alive = true
    void worktreeApi
      .list(folder)
      .then((list) => {
        if (!alive || !list) return
        const info = list.worktrees.find((w) => w.path === list.current)
        // Only the ones created by chat: the main one is never removed, the
        // pipeline ones belong to the pipeline and the external ones were
        // created by hand — removing them is not the chat's business.
        if (!info || info.origin !== "chat") return
        const others = useSessionStore
          .getState()
          .sessions.some((s) => s.id !== session.id && !!s.directory && isInside(s.directory, info.path))
        if (!others) setWorktree({ list, info })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, session.id, session.mode, session.directory])

  // What is actually lost: removing the worktree takes the uncommitted
  // changes; the commits only disappear if the branch is deleted along.
  const losses = worktree && removeWorktree
    ? [
        worktree.info.changes > 0 ? t("worktree.changes", { count: worktree.info.changes }) : null,
        deleteBranch && worktree.info.ahead > 0 ? t("worktree.ahead", { count: worktree.info.ahead }) : null,
      ].filter((p): p is string => !!p)
    : []
  const blocked = losses.length > 0 && !discard

  const confirm = async () => {
    setSubmitting(true)
    setError(null)
    try {
      // The worktree goes BEFORE the chat: if the removal fails, the chat keeps
      // existing and one can try again, instead of leaving an orphan.
      if (removeWorktree && worktree) {
        await useWorktreeStore.getState().remove(worktree.list.repo, worktree.info.path, deleteBranch)
      }
      await useSessionStore.getState().deleteSession(session.id)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("sidebar.session.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("sidebar.session.deleteDescription", { title: session.title })}</DialogDescription>
        </DialogHeader>

        {worktree && (
          <div className="space-y-2 rounded-md border p-2.5 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <FolderGit2 className="size-3.5 shrink-0" />
              {t("deleteChat.worktree", { name: worktree.info.name, branch: worktree.info.branch ?? worktree.info.head })}
            </p>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={removeWorktree} onCheckedChange={setRemoveWorktree} />
              <span>{t("deleteChat.removeWorktree")}</span>
            </label>
            {removeWorktree && (
              <>
                {worktree.info.branch && (
                  <label className="flex cursor-pointer items-center gap-2">
                    <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} />
                    <span>{t("worktree.deleteBranch", { branch: worktree.info.branch })}</span>
                  </label>
                )}
                {losses.length > 0 && (
                  <div className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                    <p>{t("deleteChat.losses", { items: losses.join(" · ") })}</p>
                    <label className="flex cursor-pointer items-center gap-2">
                      <Switch checked={discard} onCheckedChange={setDiscard} />
                      <span>{t("deleteChat.discard")}</span>
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && <p className="break-words font-mono text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={submitting || blocked}>
            {submitting && <Loader2Icon className="size-3.5 animate-spin" />}
            {t("sidebar.session.confirmDelete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
