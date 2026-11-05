import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, GitBranchIcon, GitMergeIcon, HistoryIcon, Loader2Icon } from "lucide-react"
import type { Pipeline, Task } from "@shared/pipeline"
import { pipelineFlow } from "@shared/pipeline"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"
import { pipelineApi, type PipelineIntegrationStatus } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

/**
 * The strip under the board header: the pipeline's integration branch at a
 * glance, the Merge button (a split button — the arrow picks the destination)
 * and the history. In simple mode (no worktrees) the same place holds
 * "Archive completed".
 *
 * Merge never pushes: it moves a local branch. If the integration has loose
 * changes it stops and offers to commit them (the pipeline model writes the
 * message) or to cancel.
 */
export function IntegrationBar({
  pipeline,
  tasks,
  onOpenHistory,
}: {
  pipeline: Pipeline
  tasks: Task[]
  onOpenHistory: () => void
}) {
  const { t } = useTranslation()
  const flow = pipelineFlow(pipeline)
  const [status, setStatus] = useState<PipelineIntegrationStatus | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBranch, setDefaultBranch] = useState<string | undefined>()
  const [destination, setDestination] = useState<string | null>(null)
  const [busy, setBusy] = useState<"merge" | "commit" | "archive" | null>(null)
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [dirty, setDirty] = useState<string[] | null>(null)

  // Refresh the strip when anything that changes it does: a task entering the
  // queue, being merged, or the pipeline getting its integration worktree.
  const signature = useMemo(
    () =>
      tasks.map((x) => `${x.id}:${x.status}:${x.integration?.state ?? ""}:${x.deliveryId ? 1 : 0}`).join("|") +
      `|${pipeline.integration?.branch ?? ""}`,
    [tasks, pipeline.integration?.branch],
  )

  const refresh = useCallback(async () => {
    if (flow === "simple") return
    setStatus(await pipelineApi.integration(pipeline.id))
  }, [flow, pipeline.id])

  useEffect(() => {
    void refresh()
  }, [refresh, signature])

  useEffect(() => {
    if (flow === "simple") return
    void pipelineApi.destinations(pipeline.id).then((d) => {
      setBranches(d.branches)
      setDefaultBranch(d.default)
    })
  }, [flow, pipeline.id, signature])

  const target = destination ?? defaultBranch
  const pendingCompleted = tasks.filter((x) => x.status === "completed" && !x.deliveryId).length
  const nothingToMerge = !status || (status.ahead === 0 && status.dirty.length === 0)

  const merge = async () => {
    if (!target || busy) return
    setBusy("merge")
    setMessage(null)
    try {
      const outcome = await pipelineApi.merge(pipeline.id, target)
      if (outcome.status === "delivered") {
        setMessage({ kind: "ok", text: t("pipeline.merge.done", { branch: target, count: outcome.delivery.taskIds.length }) })
      } else if (outcome.status === "dirty") {
        setDirty(outcome.files)
      } else if (outcome.status === "blocked") {
        setMessage({
          kind: "error",
          text: t("pipeline.merge.blocked", { branch: target, where: outcome.where, files: outcome.files.join(", ") }),
        })
      } else {
        setMessage({ kind: "error", text: outcome.message })
      }
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const commitThenMerge = async () => {
    setBusy("commit")
    try {
      const result = await pipelineApi.commitIntegration(pipeline.id)
      setDirty(null)
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error ?? t("pipeline.merge.commitFailed") })
        return
      }
    } finally {
      setBusy(null)
    }
    await merge()
  }

  const archive = async () => {
    setBusy("archive")
    try {
      await pipelineApi.archiveCompleted(pipeline.id)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
      {flow !== "simple" ? (
        <>
          <GitBranchIcon className="size-3.5 shrink-0" />
          <Truncate text={status?.branch ?? ""}>
            <span className="max-w-64 truncate font-mono text-foreground">
              {status?.branch ?? t("pipeline.merge.notCreated")}
            </span>
          </Truncate>
          {status && (
            <>
              <span>{t("pipeline.merge.ahead", { count: status.ahead, base: status.base })}</span>
              {status.queued > 0 && (
                <span className="flex items-center gap-1 text-primary">
                  <Loader2Icon className="size-3 animate-spin" />
                  {t("pipeline.merge.queued", { count: status.queued })}
                </span>
              )}
              {status.dirty.length > 0 && (
                <span className="text-amber-600 dark:text-amber-400" title={status.dirty.join("\n")}>
                  {t("pipeline.merge.uncommitted", { count: status.dirty.length })}
                </span>
              )}
            </>
          )}
        </>
      ) : (
        <span>{t("pipeline.merge.simpleMode")}</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {message && (
          <span
            className={cn("max-w-md truncate", message.kind === "error" ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}
            title={message.text}
          >
            {message.text}
          </span>
        )}
        <Hint label={t("pipeline.history.open")}>
          <Button size="sm" variant="ghost" onClick={onOpenHistory}>
            <HistoryIcon className="size-3.5" />
            {t("pipeline.history.title")}
          </Button>
        </Hint>
        {flow === "simple" ? (
          pendingCompleted > 0 && (
            <Button size="sm" variant="outline" disabled={busy === "archive"} onClick={() => void archive()}>
              {t("pipeline.history.archiveCompleted", { count: pendingCompleted })}
            </Button>
          )
        ) : (
          <div className={cn("flex items-center -space-x-px", (!target || nothingToMerge) && "opacity-50")}>
            <Hint label={t("pipeline.merge.hint", { branch: target ?? "…" })}>
              <Button
                size="sm"
                variant="default"
                className="h-7 rounded-r-none border border-primary disabled:opacity-100"
                disabled={!target || busy !== null || nothingToMerge}
                onClick={() => void merge()}
              >
                {busy ? <Loader2Icon className="size-4 animate-spin" /> : <GitMergeIcon className="size-4" />}
                {target ? t("pipeline.merge.into", { branch: target }) : t("pipeline.merge.button")}
              </Button>
            </Hint>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("pipeline.merge.chooseBranch")}
                disabled={busy !== null || branches.length === 0}
                className="flex h-7 items-center justify-center rounded-l-none rounded-r-md border border-primary bg-primary px-1.5 text-primary-foreground shadow hover:bg-primary/90 disabled:pointer-events-none"
              >
                <ChevronDownIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 min-w-44 overflow-y-auto">
                {branches.map((branch) => (
                  <DropdownMenuItem key={branch} onClick={() => setDestination(branch)}>
                    <GitBranchIcon className="size-3.5" />
                    <span className="truncate">{branch}</span>
                    {branch === target && <span className="ml-auto text-[10px] text-muted-foreground">✓</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <Dialog open={!!dirty} onOpenChange={(open) => !open && setDirty(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pipeline.merge.dirtyTitle")}</DialogTitle>
            <DialogDescription>{t("pipeline.merge.dirtyBody")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-[11px]">
            {dirty?.slice(0, 50).map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
            {(dirty?.length ?? 0) > 50 && <li>…</li>}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDirty(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy !== null} onClick={() => void commitThenMerge()}>
              {busy === "commit" && <Loader2Icon className="size-3.5 animate-spin" />}
              {t("pipeline.merge.commit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
