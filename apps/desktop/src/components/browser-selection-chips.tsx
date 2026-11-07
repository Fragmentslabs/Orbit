import { MousePointerClick, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Hint } from "@/components/ui/hint"
import type { BrowserSelection } from "@/src/stores/panel-store"

/** The chips of the elements picked on a page, waiting to be sent with the next message. */
export function BrowserSelectionChips({
  selections,
  onRemove,
}: {
  selections: BrowserSelection[]
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation()
  if (selections.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
      {selections.map((sel) => (
        <span
          key={sel.id}
          title={`${sel.selector}\n"${sel.text}"`}
          className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
        >
          <MousePointerClick className="size-3" />
          {"<"}{sel.tag}{">"} {sel.text ? `"${sel.text.slice(0, 24)}${sel.text.length > 24 ? "…" : ""}"` : t("codeInput.selected")}
          <Hint label={t("common.remove")}>
            <button type="button" onClick={() => onRemove(sel.id)} className="ml-0.5 rounded-sm hover:bg-emerald-500/20">
              <X className="size-3" />
            </button>
          </Hint>
        </span>
      ))}
    </div>
  )
}
