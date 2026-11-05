import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon } from "lucide-react";
import type { ChatMessage } from "@shared/chat";
import { useSessionStore } from "@/src/stores/session-store";
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store";
import { pipelineApi } from "@/src/lib/ipc";
import { parsePatch, type FileDiff } from "@/lib/unified-diff";
import { HighlightedDiffFile } from "@/src/components/diff-lines";
import { cn } from "@/lib/utils";
import { Truncate } from "@/components/ui/truncated-text"

function FileDiffSection({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(false);
  const label =
    file.oldPath === file.newPath
      ? file.oldPath
      : `${file.oldPath} → ${file.newPath}`;
  return (
    <div className="mb-3 overflow-hidden rounded-md border border-border/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent/50"
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
        
          <Truncate>
              <span className="min-w-0 truncate" title={label}>
              {label}
            </span>
          </Truncate>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
          {file.added > 0 && (
            <span className="text-emerald-500">+{file.added}</span>
          )}
          {file.removed > 0 && (
            <span className="text-red-500">-{file.removed}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="min-w-0 border-t border-border/50 font-mono text-xs">
          <HighlightedDiffFile file={file} wrap stickyHeader={false} />
        </div>
      )}
    </div>
  );
}

/**
 * Diff tab: the patch of ONE chat message or of ONE pipeline task.
 *
 * Both sources exist because the pipeline does not create messages (D12) — its
 * patch is measured by the engine and lives in the task itself.
 *
 * It does not show up in the tab picker: without context there is nothing to
 * show, and the current changes are read in the folders tab (Changes). It opens
 * from the message's "+N -N" badge and from the task card, already pointing at
 * its origin.
 */
export function DiffTab({
  sessionId,
  messageId,
  pipelineId,
  taskId,
}: {
  sessionId?: string;
  messageId?: string;
  pipelineId?: string;
  taskId?: string;
}) {
  const { t } = useTranslation();
  const fromPipeline = !!(pipelineId && taskId);
  const resolvedSessionId = fromPipeline ? "" : (sessionId ?? "");
  const resolvedMessageId = fromPipeline ? "" : (messageId ?? "");

  const messages = useSessionStore((s) => s.messages[resolvedSessionId]);
  const message: ChatMessage | undefined = useMemo(
    () => messages?.find((m) => m.id === resolvedMessageId),
    [messages, resolvedMessageId],
  );

  const task = usePipelineStore((s) =>
    pipelineId && taskId
      ? (s.tasksPerPipeline[pipelineId] ?? EMPTY_TASKS).find((x) => x.id === taskId)
      : undefined,
  );

  // A delivered task keeps no patch: it is read back from git by its merge commit.
  const [archivedPatch, setArchivedPatch] = useState<string | null>(null);
  const needsGit = !!(fromPipeline && task?.deliveryId && !task.diff?.patch);
  useEffect(() => {
    if (!needsGit || !pipelineId || !taskId) return;
    let cancelled = false;
    void pipelineApi.taskDiff(pipelineId, taskId).then((result) => {
      if (!cancelled) setArchivedPatch(result?.patch ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [needsGit, pipelineId, taskId]);

  const patch = fromPipeline ? task?.diff?.patch || archivedPatch || undefined : message?.snapshot?.patch;
  const totalFiles = fromPipeline
    ? task?.diff?.files?.length
    : message?.snapshot?.files?.length;

  const files = useMemo(() => (patch ? parsePatch(patch) : null), [patch]);

  if (fromPipeline ? !task : !message) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("diff.noChanges")}
      </div>
    );
  }

  if (!files || files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("diff.noChangesInMessage")}
      </div>
    );
  }

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {t("diff.filesCount", { count: totalFiles ?? files.length })}
        </span>
        {totalAdded > 0 && (
          <span className="text-emerald-500">+{totalAdded}</span>
        )}
        {totalRemoved > 0 && (
          <span className="text-red-500">-{totalRemoved}</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto pr-0.5">
        {files.map((file, i) => (
          <FileDiffSection key={i} file={file} />
        ))}
      </div>
    </div>
  );
}
