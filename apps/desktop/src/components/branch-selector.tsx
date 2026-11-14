import { useCallback, useEffect, useRef, useState } from "react"
import { usePeersStore } from "@/src/stores/peers-store"
import { useTranslation, Trans } from "react-i18next"
import { GitBranch, Check, Loader2Icon, PlusIcon } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBranchStore } from "@/src/stores/branch-store"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Checkout of a branch open in another worktree: git refuses ("already used
 * by worktree at '…'", or "already checked out at" in older versions). It is not
 * the uncommitted changes case — the right dialog is another one.
 */
export function usedByWorktreeIn(error: string): string | null {
  return /already (?:used by worktree|checked out) at '([^']+)'/.exec(error)?.[1] ?? null
}

interface BranchSelectorProps {
  repoPath: string
  onRequestAgentAction?: (instruction: string) => void
  /** Controls the opening of the dropdown externally (used together with hideTrigger) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Omits the trigger button — used when another component opens this dropdown */
  hideTrigger?: boolean
  /**
   * Side on which the dropdown opens. The folders footer sits at the bottom of the panel,
   * so there it opens UPWARDS — downwards it would leave the window.
   */
  side?: "top" | "bottom"
  /** Lean trigger (no border, shorter) for narrow bars. */
  compact?: boolean
}

/** The branches live in a repository ON the machine the folder belongs to; another desktop's paths mean nothing here. */
export function BranchSelector(props: BranchSelectorProps) {
  const remote = usePeersStore((s) => s.env !== "local")
  return remote ? null : <LocalBranchSelector {...props} />
}

function LocalBranchSelector({ repoPath, onRequestAgentAction, open: openProp, onOpenChange, hideTrigger, side = "bottom", compact = false }: BranchSelectorProps) {
  const { t } = useTranslation()
  const byDir = useBranchStore((s) => s.byDir[repoPath])
  const loading = useBranchStore((s) => s.loading)
  const fetchBranches = useBranchStore((s) => s.fetchBranches)
  const checkoutBranch = useBranchStore((s) => s.checkoutBranch)
  const createBranch = useBranchStore((s) => s.createBranch)
  const commitChanges = useBranchStore((s) => s.commitChanges)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openProp ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [usedBy, setUsedBy] = useState<{ branch: string; path: string } | null>(null)
  const [pendingBranch, setPendingBranch] = useState<string | null>(null)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState("")
  const [committing, setCommitting] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [branchName, setBranchName] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchBranches(repoPath)
  }, [repoPath, fetchBranches])

  // hideTrigger has no visible <button> for the Base UI Menu to anchor to — only
  // that case (composition via CompactWorkspaceSelector) uses the manual dropdown
  // with closing on outside click; the normal case uses the Menu (portal, z above
  // any chat overlay, native alignment).
  useEffect(() => {
    if (!hideTrigger || !open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [hideTrigger, open, setOpen])

  const retryCheckout = useCallback(async (branch: string) => {
    setCheckoutLoading(true)
    const result = await checkoutBranch(repoPath, branch)
    setCheckoutLoading(false)
    if (!result.ok) {
      const path = usedByWorktreeIn(result.error ?? "")
      if (path) {
        setUsedBy({ branch, path })
        return
      }
      setConflictError(result.error ?? t("branch.unknownError"))
      setPendingBranch(branch)
    }
  }, [checkoutBranch, repoPath, t])

  const handleSelect = useCallback(async (branch: string) => {
    if (branch === byDir?.current) return
    setCheckoutLoading(true)
    setOpen(false)
    const result = await checkoutBranch(repoPath, branch)
    setCheckoutLoading(false)
    if (!result.ok) {
      const path = usedByWorktreeIn(result.error ?? "")
      if (path) {
        setUsedBy({ branch, path })
        return
      }
      setConflictError(result.error ?? t("branch.unknownError"))
      setPendingBranch(branch)
    }
  }, [byDir, checkoutBranch, repoPath, t, setOpen])

  const handleCommitAndSwitch = useCallback(async () => {
    if (!pendingBranch || !commitMessage.trim()) return
    setCommitting(true)
    const result = await commitChanges(repoPath, commitMessage.trim())
    setCommitting(false)
    setCommitDialogOpen(false)
    setCommitMessage("")
    if (result.ok) {
      setConflictError(null)
      setPendingBranch(null)
      retryCheckout(pendingBranch)
    } else {
      setConflictError(result.error ?? t("branch.commitError"))
    }
  }, [pendingBranch, commitMessage, commitChanges, repoPath, retryCheckout, t])

  const handleAgentResolve = useCallback(() => {
    if (!pendingBranch) return
    setConflictError(null)
    setPendingBranch(null)
    onRequestAgentAction?.(t("branch.agentResolvePrompt", { branch: pendingBranch }))
  }, [pendingBranch, onRequestAgentAction, t])

  const openCreateDialog = useCallback(() => {
    setOpen(false)
    setBranchName("")
    setCreateError(null)
    setCreateDialogOpen(true)
  }, [setOpen])

  const handleCreate = useCallback(async () => {
    const name = branchName.trim()
    if (!name || creating) return
    setCreating(true)
    setCreateError(null)
    const result = await createBranch(repoPath, name)
    setCreating(false)
    if (result.ok) {
      setCreateDialogOpen(false)
      setBranchName("")
    } else {
      setCreateError(result.error ?? t("branch.unknownError"))
    }
  }, [branchName, creating, createBranch, repoPath, t])

  const data = byDir
  if (!data || data.branches.length === 0) return null

  const branchItems = (
    <>
      {data.branches.map((branch) => {
        const active = branch === data.current
        return (
          <Hint label={branch}>
            <button
              key={branch}
              type="button"
              onClick={() => handleSelect(branch)}
              // The dropdown has a fixed width (w-44) and a branch name is long by
              // convention — `feature/`, `fix/`, ticket number. Without the title, the
              // ellipsis hides precisely the part that distinguishes one from the other.
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                active ? "bg-primary/10 text-primary" : "hover:bg-foreground/10",
              )}
            >
       
               <GitBranch className="size-3 shrink-0" />
            <span className="flex-1 truncate">{branch}</span>
            {active && <Check className="size-3 shrink-0" />}
          </button>
          </Hint>
        )
      })}
      <div className="mt-1 border-t border-foreground/10 pt-1">
        <button
          type="button"
          onClick={openCreateDialog}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <PlusIcon className="size-3.5 shrink-0" />
          {t("branch.newBranch")}
        </button>
      </div>
    </>
  )

  return (
    <>
      {hideTrigger ? (
        <div className="relative" ref={ref}>
          {open && (
            <div className="absolute left-0 top-full mt-1 z-[60] w-44 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
              {branchItems}
            </div>
          )}
        </div>
      ) : (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          {/* The tooltip wraps the trigger, never the other way around: passed as the
              trigger's `render` element, the Hint received the trigger props and dropped
              every one of them — handlers, ref, id — together with the trigger's children,
              so the button came out empty and opened nothing. With the Hint outside and
              THE CONTENT INSIDE the button, both triggers land on the same node. */}
          <Hint label={data.current || t("branch.detached")}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  disabled={loading || checkoutLoading}
                  className={cn(
                    "flex h-7 items-center gap-1 rounded-md border border-border px-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                    compact && "h-6 min-w-0 flex-1 border-0 px-1",
                  )}
                >
                  {loading || checkoutLoading ? (
                    <Loader2Icon className="size-3 animate-spin" />
                  ) : (
                    <GitBranch className="size-3 text-muted-foreground" />
                  )}
                  <Truncate>
                    <span className={cn("truncate", compact ? "min-w-0 flex-1 text-left" : "max-w-20")}>
                      {data.current || t("branch.detached")}
                    </span>
                  </Truncate>
                </button>
              }
            />
          </Hint>
          <DropdownMenuContent align={compact ? "start" : "end"} className="w-44 p-1" side={side}>
            {branchItems}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Conflict dialog */}
      <Dialog open={conflictError !== null} onOpenChange={(v) => { if (!v) { setConflictError(null); setPendingBranch(null) } }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("branch.uncommittedTitle")}</DialogTitle>
            <DialogDescription>
              <Trans i18nKey="branch.uncommittedDesc" values={{ branch: pendingBranch }} components={{ strong: <strong /> }} />
              <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">{conflictError}</pre>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button variant="default" className="w-full" onClick={() => { setCommitDialogOpen(true); setCommitMessage(t("branch.wipDefault", { branch: pendingBranch })) }}>
              {t("branch.commitChanges")}
            </Button>
            <Button variant="secondary" className="w-full" onClick={handleAgentResolve}>
              {t("branch.agentResolve")}
            </Button>
            <Button variant="outline" className="w-full" onClick={() => { setConflictError(null); setPendingBranch(null) }}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Branch open in another worktree */}
      <Dialog open={usedBy !== null} onOpenChange={(v) => !v && setUsedBy(null)}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("branch.inUseTitle", { branch: usedBy?.branch })}</DialogTitle>
            <DialogDescription>
              {t("branch.inUseDescription")}
              <span className="mt-2 block break-all rounded bg-muted p-2 font-mono text-xs text-muted-foreground">{usedBy?.path}</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setUsedBy(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Commit message dialog */}
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("branch.commitTitle")}</DialogTitle>
            <DialogDescription>{t("branch.commitDesc")}</DialogDescription>
          </DialogHeader>
          <Input
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder={t("branch.wipPlaceholder")}
            className="mt-2"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommitDialogOpen(false)} disabled={committing}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleCommitAndSwitch} disabled={!commitMessage.trim() || committing}>
              {committing ? t("branch.committing") : t("branch.commitAndSwitch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create branch dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("branch.createTitle")}</DialogTitle>
            <DialogDescription>{t("branch.createDesc")}</DialogDescription>
          </DialogHeader>
          <Input
            value={branchName}
            onChange={(e) => {
              setBranchName(e.target.value)
              setCreateError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate()
            }}
            placeholder={t("branch.createPlaceholder")}
            className="mt-2"
            autoFocus
          />
          {createError && (
            <p className="mt-1 break-words font-mono text-xs text-destructive">{createError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)} disabled={creating}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!branchName.trim() || creating}>
              {creating ? t("branch.creating") : t("branch.createAndSwitch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
