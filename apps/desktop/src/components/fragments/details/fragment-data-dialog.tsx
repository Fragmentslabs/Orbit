import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw } from "lucide-react"
import type { FragmentDataEntry } from "@shared/fragment-details"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Hint } from "@/components/ui/hint"
import { formatBytes } from "@/src/lib/format"
import { fragmentApi } from "@/src/lib/ipc"

/**
 * What the fragment saved with `orbit.store`, as a read-only list of keys and values. The
 * page writes through its own broker; nothing here can edit or delete, so looking at the
 * data is always safe. It does not stream: the page can save without any event, hence the
 * refresh button.
 */
export function FragmentDataDialog({
  fragmentId,
  open,
  onOpenChange,
}: {
  fragmentId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<FragmentDataEntry[] | null>(null)
  const read = useCallback(() => void fragmentApi.data(fragmentId).then(setEntries), [fragmentId])
  useEffect(() => {
    if (open) read()
  }, [open, read])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("fragments.data.title")}
            <Hint label={t("fragments.data.refresh")}>
              <button
                type="button"
                aria-label={t("fragments.data.refresh")}
                onClick={read}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </Hint>
          </DialogTitle>
          <DialogDescription>{t("fragments.data.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {entries?.length === 0 && <p className="text-sm text-muted-foreground">{t("fragments.details.databaseEmpty")}</p>}
          {entries?.map((entry) => (
            <div key={entry.key} className="rounded-lg border border-border/60">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-1.5 text-xs">
                <code className="truncate font-medium">{entry.key}</code>
                <span className="shrink-0 text-muted-foreground">{formatBytes(entry.bytes)}</span>
              </div>
              <pre className="max-h-60 overflow-auto p-3 text-[11px] leading-relaxed">{entry.json}</pre>
              {entry.truncated && <p className="px-3 pb-2 text-[11px] text-muted-foreground">{t("fragments.data.truncated")}</p>}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
