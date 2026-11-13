import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw } from "lucide-react"
import type { FragmentDataEntry } from "@shared/fragment-details"
import { Hint } from "@/components/ui/hint"
import { formatBytes } from "@/src/lib/format"
import { fragmentApi } from "@/src/lib/ipc"

/**
 * What the fragment saved with `orbit.store`, as a read-only list of keys and values, in the
 * "Data" tab of the details panel. The page writes through its own broker; nothing here can
 * edit or delete, so looking at the data is always safe. It does not stream: the page can save
 * without any event, hence the refresh button.
 */
export function FragmentDataView({
  fragmentId,
  embedded = false,
}: {
  fragmentId: string
  /** Inside a details card: its own title would repeat the card's label. */
  embedded?: boolean
}) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<FragmentDataEntry[] | null>(null)
  const read = useCallback(() => void fragmentApi.data(fragmentId).then(setEntries), [fragmentId])
  useEffect(() => {
    read()
  }, [read])

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {!embedded && <p className="text-xs font-medium">{t("fragments.data.title")}</p>}
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t("fragments.data.description")}</p>
        </div>
        <Hint label={t("fragments.data.refresh")}>
          <button
            type="button"
            aria-label={t("fragments.data.refresh")}
            onClick={read}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </Hint>
      </div>

      {entries?.length === 0 && <p className="text-xs text-muted-foreground">{t("fragments.details.databaseEmpty")}</p>}

      {entries?.map((entry) => (
        <div key={entry.key} className="overflow-hidden rounded-md border border-sidebar-border/60">
          <div className="flex items-center justify-between gap-3 border-b border-sidebar-border/60 px-2.5 py-1.5 text-[11px]">
            <code className="truncate font-medium">{entry.key}</code>
            <span className="shrink-0 text-muted-foreground">{formatBytes(entry.bytes)}</span>
          </div>
          <pre className="max-h-60 overflow-auto p-2.5 text-[11px] leading-relaxed">{entry.json}</pre>
          {entry.truncated && <p className="px-2.5 pb-2 text-[11px] text-muted-foreground">{t("fragments.data.truncated")}</p>}
        </div>
      ))}
    </div>
  )
}
