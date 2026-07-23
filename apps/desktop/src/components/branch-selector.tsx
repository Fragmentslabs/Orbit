import { useCallback, useEffect, useRef, useState } from "react"
import { GitBranch, Check, LoaderIcon } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useBranchStore } from "@/src/stores/branch-store"
import { cn } from "@/lib/utils"

interface BranchSelectorProps {
  repoPath: string
  onRequestAgentAction?: (instruction: string) => void
}

export function BranchSelector({ repoPath, onRequestAgentAction }: BranchSelectorProps) {
  const byDir = useBranchStore((s) => s.byDir[repoPath])
  const loading = useBranchStore((s) => s.loading)
  const fetchBranches = useBranchStore((s) => s.fetchBranches)
  const checkoutBranch = useBranchStore((s) => s.checkoutBranch)
  const commitChanges = useBranchStore((s) => s.commitChanges)
  const [open, setOpen] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [pendingBranch, setPendingBranch] = useState<string | null>(null)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState("")
  const [committing, setCommitting] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchBranches(repoPath)
  }, [repoPath, fetchBranches])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const retryCheckout = useCallback(async (branch: string) => {
    setCheckoutLoading(true)
    const result = await checkoutBranch(repoPath, branch)
    setCheckoutLoading(false)
    if (!result.ok) {
      setConflictError(result.error ?? "Erro desconhecido")
      setPendingBranch(branch)
    }
  }, [checkoutBranch, repoPath])

  const handleSelect = useCallback(async (branch: string) => {
    if (branch === byDir?.current) return
    setCheckoutLoading(true)
    setOpen(false)
    const result = await checkoutBranch(repoPath, branch)
    setCheckoutLoading(false)
    if (!result.ok) {
      setConflictError(result.error ?? "Erro desconhecido")
      setPendingBranch(branch)
    }
  }, [byDir, checkoutBranch, repoPath])

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
      setConflictError(result.error ?? "Erro ao commitar")
    }
  }, [pendingBranch, commitMessage, commitChanges, repoPath, retryCheckout])

  const handleAgentResolve = useCallback(() => {
    if (!pendingBranch) return
    setConflictError(null)
    setPendingBranch(null)
    onRequestAgentAction?.(`Tenho mudanças não commitadas no repositório e preciso trocar para a branch "${pendingBranch}". Faça commit ou stash das mudanças e depois execute o checkout para a branch "${pendingBranch}".`)
  }, [pendingBranch, onRequestAgentAction])

  const data = byDir
  if (!data || data.branches.length === 0) return null

  return (
    <>
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={loading || checkoutLoading}
          className="flex h-7 items-center gap-1 rounded-md border border-border px-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {loading || checkoutLoading ? (
            <LoaderIcon className="size-3 animate-spin" />
          ) : (
            <GitBranch className="size-3 text-muted-foreground" />
          )}
          <span className="max-w-20 truncate">{data.current || "(detached)"}</span>
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-1 z-50 w-44 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150">
            {data.branches.map((branch) => {
              const active = branch === data.current
              return (
                <button
                  key={branch}
                  type="button"
                  onClick={() => handleSelect(branch)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                    active ? "bg-primary/10 text-primary" : "hover:bg-foreground/10",
                  )}
                >
                  <GitBranch className="size-3 shrink-0" />
                  <span className="flex-1 truncate">{branch}</span>
                  {active && <Check className="size-3 shrink-0" />}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Conflict dialog */}
      <Dialog open={conflictError !== null} onOpenChange={(v) => { if (!v) { setConflictError(null); setPendingBranch(null) } }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Mudanças não commitadas</DialogTitle>
            <DialogDescription>
              Existem mudanças locais que seriam sobrescritas ao trocar para branch <strong>{pendingBranch}</strong>.
              <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted p-2 text-xs text-muted-foreground">{conflictError}</pre>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button variant="default" className="w-full" onClick={() => { setCommitDialogOpen(true); setCommitMessage(`wip: mudanças antes de trocar para ${pendingBranch}`) }}>
              Commitar mudanças
            </Button>
            <Button variant="secondary" className="w-full" onClick={handleAgentResolve}>
              Deixar IA resolver
            </Button>
            <Button variant="outline" className="w-full" onClick={() => { setConflictError(null); setPendingBranch(null) }}>
              Cancelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Commit message dialog */}
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Mensagem de commit</DialogTitle>
            <DialogDescription>Digite uma mensagem para commitar as mudanças antes de trocar de branch.</DialogDescription>
          </DialogHeader>
          <Input
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="wip: mudanças antes de trocar de branch"
            className="mt-2"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommitDialogOpen(false)} disabled={committing}>
              Cancelar
            </Button>
            <Button onClick={handleCommitAndSwitch} disabled={!commitMessage.trim() || committing}>
              {committing ? "Commitando…" : "Commitar e trocar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
