import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, FolderGit2, Loader2Icon, PlusIcon, XIcon } from "lucide-react"
import { BASE_REMOTE, type WorktreeInfo } from "@shared/worktrees"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useBranchStore } from "@/src/stores/branch-store"
import { useWorktreeStore } from "@/src/stores/worktree-store"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/** Shown name: the main one appears as "Main", not by the folder name. */
export function useCurrentWorktreeLabel(folder: string | undefined): string | null {
  const { t } = useTranslation()
  const list = useWorktreeStore((s) => (folder ? s.byFolder[folder] : undefined))
  if (!list) return null
  const current = list.worktrees.find((w) => w.path === list.current)
  if (!current) return null
  return current.primary ? t("worktree.main") : current.name
}

/**
 * Chat worktree picker (header): which working copy of the repository this chat
 * works in. Lists the worktrees — including the ones created outside Orbit and
 * the pipeline tasks' —, switches the chat's folder, creates and removes.
 * Hidden when the folder is not a git repository.
 *
 * Switching only changes this chat's main folder (the extra ones stay): the
 * next message already runs there.
 */
export function WorktreeSelector({
  folder,
  onSwitch,
  suggestedName,
  open: openProp,
  onOpenChange,
  hideTrigger,
}: {
  /** Main folder of the chat */
  folder: string
  /** Swaps the main folder of the chat to this one */
  onSwitch: (folder: string) => void
  /** Name suggestion for a new worktree (e.g. chat title) */
  suggestedName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** No button of its own — opened by the compact selector */
  hideTrigger?: boolean
}) {
  const { t } = useTranslation()
  const list = useWorktreeStore((s) => s.byFolder[folder])
  const loading = useWorktreeStore((s) => s.loading[folder] ?? false)
  const load = useWorktreeStore((s) => s.load)
  const [openInternal, setInternalOpen] = useState(false)
  const open = openProp ?? openInternal
  const setOpen = onOpenChange ?? setInternalOpen
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<WorktreeInfo | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load(folder)
  }, [folder, load])

  // The state (changes, commits ahead) changes while one works: it reloads
  // on opening, so the list does not show the snapshot from when the chat opened.
  useEffect(() => {
    if (open) void load(folder)
  }, [open, folder, load])

  // hideTrigger: manual dropdown anchored in the wrapper, with closing on
  // outside click — the same arrangement as the BranchSelector in the compact selector.
  useEffect(() => {
    if (!hideTrigger || !open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [hideTrigger, open, setOpen])

  if (!list) return null
  const current = list.worktrees.find((w) => w.path === list.current)
  const currentLabel = !current || current.primary ? t("worktree.main") : current.name

  const items = (
    <>
      <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("worktree.title")}
      </p>
      {list.worktrees.map((w) => (
        <WorktreeRow
          key={w.path}
          worktree={w}
          current={w.path === list.current}
          onChoose={() => {
            setOpen(false)
            if (w.path !== list.current) onSwitch(w.folder)
          }}
          onRemove={() => {
            setOpen(false)
            setRemoving(w)
          }}
        />
      ))}
      <div className="mt-1 border-t border-foreground/10 pt-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setCreating(true)
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <PlusIcon className="size-3.5 shrink-0" />
          {t("worktree.new")}
        </button>
      </div>
    </>
  )

  return (
    <>
      {hideTrigger ? (
        <div className="relative" ref={ref}>
          {open && (
            <div className="absolute left-0 top-full z-[60] mt-1 w-72 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
              {items}
            </div>
          )}
        </div>
      ) : (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          {/* Same arrangement as the BranchSelector: tooltip OUTSIDE the trigger, content
              inside its button — as the `render` element the Hint swallowed the trigger
              props and its children, leaving an empty button that opened nothing. */}
          <Hint label={t("worktree.currentTitle", { name: currentLabel })}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "flex h-7 items-center gap-1 rounded-md border px-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                    current && !current.primary ? "border-primary/40 bg-primary/5" : "border-border",
                  )}
                >
                  {loading && !list ? (
                    <Loader2Icon className="size-3 animate-spin" />
                  ) : (
                    <FolderGit2 className={cn("size-3", current && !current.primary ? "text-primary" : "text-muted-foreground")} />
                  )}
                  <Truncate>
                    <span className="max-w-24 truncate">{currentLabel}</span>
                  </Truncate>
                </button>
              }
            />
          </Hint>
          <DropdownMenuContent align="end" className="w-72 p-1">
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <CreateWorktreeDialog
        open={creating}
        onOpenChange={setCreating}
        folder={folder}
        repo={list.repo}
        defaultRemote={list.defaultRemote}
        suggestedName={suggestedName}
        onCreated={(newFolder) => onSwitch(newFolder)}
      />
      <RemoveWorktreeDialog worktree={removing} folder={folder} onOpenChange={(v) => !v && setRemoving(null)} />
    </>
  )
}

function WorktreeRow({
  worktree: w,
  current,
  onChoose,
  onRemove,
}: {
  worktree: WorktreeInfo
  current: boolean
  onChoose: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  // The main one does not go (it is not a removable worktree) and the pipeline
  // ones belong to the pipeline; neither does the current one — the chat has to
  // move to another one first.
  const removable = !w.primary && w.origin !== "pipeline" && !current
  const details = [
    w.branch ?? t("worktree.detached", { head: w.head }),
    w.changes > 0 ? t("worktree.changes", { count: w.changes }) : null,
    w.ahead > 0 ? t("worktree.ahead", { count: w.ahead }) : null,
    w.origin === "pipeline" ? t("worktree.pipelineName") : w.origin === "external" ? t("worktree.external") : null,
    w.available ? null : t("worktree.missing"),
  ].filter(Boolean)

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md transition-colors",
        current ? "bg-primary/10 text-primary" : "hover:bg-foreground/10",
      )}
    >
      <Hint label={w.path}>
        <button
          type="button"
          disabled={!w.available}
          onClick={onChoose}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
        >
       
       <FolderGit2 className="size-3 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{w.primary ? t("worktree.main") : w.name}</span>
          <span className={cn("block truncate text-[10px]", current ? "text-primary/70" : "text-muted-foreground")}>
            {details.join(" · ")}
          </span>
        </span>
        {current && <Check className="size-3 shrink-0" />}
      </button>
      </Hint>
      {removable && (
        <Hint label={t("worktree.remove")}>
          <button
            type="button"
            onClick={onRemove}
            aria-label={t("worktree.remove")}

            className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
          >
            <XIcon className="size-3" />
          </button>
        </Hint>
      )}
    </div>
  )
}

function CreateWorktreeDialog({
  open,
  onOpenChange,
  folder,
  repo,
  defaultRemote,
  suggestedName,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  folder: string
  repo: string
  /** Default branch of origin (e.g. origin/main) — the "updated remote" base */
  defaultRemote?: string
  suggestedName?: string
  onCreated: (folder: string) => void
}) {
  const { t } = useTranslation()
  const create = useWorktreeStore((s) => s.create)
  const branches = useBranchStore((s) => s.byDir[repo])
  const fetchBranches = useBranchStore((s) => s.fetchBranches)
  const [name, setName] = useState("")
  const [base, setBase] = useState("")
  const [switchTo, setSwitchTo] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(suggestedName && !/^nova sess/i.test(suggestedName) ? suggestedName : "")
    setBase("")
    setSwitchTo(true)
    setError(null)
    void fetchBranches(repo)
  }, [open, suggestedName, repo, fetchBranches])

  const confirm = async () => {
    if (!name.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await create(folder, name.trim(), base || undefined)
      onOpenChange(false)
      if (switchTo) onCreated(created.folder)
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
          <DialogTitle>{t("worktree.createTitle")}</DialogTitle>
          <DialogDescription>{t("worktree.createDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("worktree.name")}</p>
            <Input
              value={name}
              autoFocus
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirm()
              }}
              placeholder={t("worktree.namePlaceholder")}
            />
            <p className="text-[11px] text-muted-foreground">{t("worktree.nameHint")}</p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("worktree.base")}</p>
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
            >
              <option value="" className="bg-popover text-popover-foreground">
                {t("worktree.currentBase", { branch: branches?.current ?? "HEAD" })}
              </option>
              {/* The Claude Code "fresh": it starts from the remote after a fetch,
                  without taking local commits that have not been pushed yet. */}
              {defaultRemote && (
                <option value={BASE_REMOTE} className="bg-popover text-popover-foreground">
                  {t("worktree.remoteBase", { remote: defaultRemote })}
                </option>
              )}
              {(branches?.branches ?? [])
                .filter((b) => b !== branches?.current)
                .map((b) => (
                  <option key={b} value={b} className="bg-popover text-popover-foreground">
                    {b}
                  </option>
                ))}
            </select>
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <Switch checked={switchTo} onCheckedChange={setSwitchTo} />
            <span className="text-xs">{t("worktree.switchToIt")}</span>
          </label>

          {submitting && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" />
              {t("worktree.preparing")}
            </p>
          )}
          {error && <p className="break-words font-mono text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void confirm()} disabled={!name.trim() || submitting}>
            {t("worktree.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RemoveWorktreeDialog({
  worktree,
  folder,
  onOpenChange,
}: {
  worktree: WorktreeInfo | null
  folder: string
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const remove = useWorktreeStore((s) => s.remove)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDeleteBranch(false)
    setError(null)
  }, [worktree?.path])

  if (!worktree) return null

  const confirm = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await remove(folder, worktree.path, deleteBranch)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("worktree.removeTitle", { name: worktree.name })}</DialogTitle>
          <DialogDescription>{t("worktree.removeDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 text-xs">
          {worktree.changes > 0 && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">
              {t("worktree.removeChanges", { count: worktree.changes })}
            </p>
          )}
          {worktree.origin === "external" && (
            <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-2 text-yellow-700 dark:text-yellow-300">
              {t("worktree.removeExternal", { path: worktree.path })}
            </p>
          )}
          {worktree.branch && (
            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={deleteBranch} onCheckedChange={setDeleteBranch} />
              <span>
                {t("worktree.deleteBranch", { branch: worktree.branch })}
                {worktree.ahead > 0 && deleteBranch && (
                  <span className="block text-[11px] text-destructive">
                    {t("worktree.deleteBranchWarning", { count: worktree.ahead })}
                  </span>
                )}
              </span>
            </label>
          )}
          {error && <p className="break-words font-mono text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={submitting}>
            {submitting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {t("worktree.remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
