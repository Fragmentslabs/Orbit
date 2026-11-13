import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { MessagePart } from "@shared/chat"
import { usePanelStore } from "@/src/stores/panel-store"

import { Hint } from "@/components/ui/hint"
/**
 * "+N -N" badge of the turn: the lines the tools added and removed from the
 * working tree, with the diff opened in the panel on click.
 *
 * It lives in the FOOTER of the message (right corner, in the copy/speak/
 * usage row), and not in the header of the actions accordion: the accordion collapses
 * by itself when the turn ends, and the balance of what changed is exactly what
 * one looks for at the END of the message. Detailed mode does not lose the badge either.
 */

/** Did the turn touch a file? `bash` also changes the working tree, but the badge
 *  promises the diff of the edits — with none, it has nothing to open.
 *
 *  The parts are not enough on their own: a write/edit called INSIDE run_tools
 *  runs from a script and never becomes a part of the message (only the
 *  `run_tools` call does), so a turn that rewrote ten files showed no badge. The
 *  snapshot's `authored` is the engine's own record of what the turn's write
 *  tools touched — it is filled through the same journal whichever tool made the
 *  call — and it is the evidence that counts when it exists (absent in turns
 *  prior to the journal). */
function wroteFiles(parts: MessagePart[], authored?: string[]): boolean {
  if (authored && authored.length > 0) return true
  return parts.some((p) => p.type === "tool" && (p.tool === "write" || p.tool === "edit"))
}

/** Lines added/removed in the unified patch of the snapshot (the "+++"/"---"
 *  headers do not count). */
function diffCountsOf(patch?: string): { added: number; removed: number } | null {
  if (!patch) return null
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  if (added === 0 && removed === 0) return null
  return { added, removed }
}

export function DiffBadge({ patch, authored, parts, sessionId, messageId }: {
  /** Unified patch of the turn snapshot (message.snapshot.patch). */
  patch?: string
  /** Paths the turn's write tools touched (message.snapshot.authored). */
  authored?: string[]
  /** Parts of the turn — it is from them that "there was a file edit" comes. */
  parts: MessagePart[]
  sessionId?: string
  messageId?: string
}) {
  const { t } = useTranslation()
  const counts = useMemo(() => diffCountsOf(patch), [patch])
  if (!counts || !sessionId || !messageId || !wroteFiles(parts, authored)) return null

  return (
    <Hint label={t("diff.open")}>
      <button
        type="button"
        onClick={() => usePanelStore.getState().openDiff(sessionId, messageId, "Diff")}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {
    counts.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{counts.added}</span>}
      {counts.removed > 0 && <span className="text-red-600 dark:text-red-400">-{counts.removed}</span>}
    </button>
    </Hint>
  )
}
