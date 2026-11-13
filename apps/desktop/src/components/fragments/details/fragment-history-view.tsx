import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { RotateCcw } from "lucide-react"
import type { FragmentRevisionInfo } from "@shared/fragment-details"
import { Button } from "@/components/ui/button"
import { formatTime } from "@/src/lib/format"
import { fragmentApi } from "@/src/lib/ipc"
import { groupRevisionsByTurn } from "./revision-groups"

/**
 * What the agent changed, turn by turn, newest first, in the "History" tab of the details
 * panel. "Undo from here" puts the files back as they were before that turn — and drops it and
 * everything after it. Only the person can do it.
 */
export function FragmentHistoryView({ fragmentId }: { fragmentId: string }) {
  const { t, i18n } = useTranslation()
  const [revisions, setRevisions] = useState<FragmentRevisionInfo[] | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const read = useCallback(() => void fragmentApi.history(fragmentId).then(setRevisions), [fragmentId])
  useEffect(() => {
    read()
  }, [read])

  const turns = useMemo(() => groupRevisionsByTurn(revisions ?? []), [revisions])

  const undo = async (revision: number) => {
    await fragmentApi.revert(fragmentId, revision)
    setConfirming(null)
    read()
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("fragments.history.hint")}</p>
      {turns.length === 0 && <p className="text-xs text-muted-foreground">{t("fragments.history.empty")}</p>}
      {turns.map((turn) => (
        <div key={turn.turn} className="rounded-md border border-sidebar-border/60 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {new Date(turn.at).toLocaleDateString(i18n.language)} · {formatTime(turn.at, i18n.language)}
            </span>
            {confirming === turn.firstRevision ? (
              <span className="flex items-center gap-1">
                <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" onClick={() => void undo(turn.firstRevision)}>
                  {t("fragments.history.confirm")}
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setConfirming(null)}>
                  {t("fragments.cancel")}
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => setConfirming(turn.firstRevision)}>
                <RotateCcw className="size-3" />
                {t("fragments.history.undo")}
              </Button>
            )}
          </div>
          <ul className="mt-1.5 flex flex-col gap-0.5 text-[11px]">
            {turn.changes.map((change) => (
              <li key={change.revision} className="flex gap-2">
                <span className="w-12 shrink-0 text-muted-foreground">{t(`fragments.history.kind.${change.kind}`)}</span>
                <span className="truncate">{change.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {turns.length > 0 && <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">{t("fragments.history.description")}</p>}
    </div>
  )
}
