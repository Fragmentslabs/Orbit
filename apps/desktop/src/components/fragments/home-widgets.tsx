import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useWorkspace } from "@/lib/workspace-context"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentIcon } from "./fragment-icon"
import { FragmentPreview } from "./fragment-preview"

/** The size a widget is laid out at before it is scaled to its card — small on purpose: a widget is a glance. */
const WIDGET_W = 360
const WIDGET_H = 220

/**
 * The widgets pinned to the home screen: small live cards under the invitation. Each one
 * is the real page, read-only (it can show what it saved, but cannot write or spend
 * tokens from here), and a click opens the full fragment. Renders nothing without widgets,
 * so the home screen stays as it was for anyone who never made one.
 */
export function HomeWidgets() {
  const { t } = useTranslation()
  const { setView } = useWorkspace()
  const items = useFragmentsStore((s) => s.items)
  const loaded = useFragmentsStore((s) => s.loaded)
  const load = useFragmentsStore((s) => s.load)
  const open = useFragmentsStore((s) => s.open)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const widgets = items.filter((f) => f.pinned.home)
  if (widgets.length === 0) return null

  return (
    <div className="grid w-full max-w-2xl grid-cols-2 gap-3 px-4 pb-6 sm:grid-cols-3">
      {widgets.map((widget) => (
        <button
          key={widget.id}
          type="button"
          onClick={() => {
            open(widget.id)
            setView("fragments")
          }}
          className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FragmentPreview manifest={widget} pageWidth={WIDGET_W} pageHeight={WIDGET_H} readOnly fit="aspect" />
          <span className="flex items-center gap-1.5 border-t border-border/60 px-2.5 py-1.5 text-xs">
            <FragmentIcon name={widget.icon} className="size-3.5 shrink-0 text-primary" />
            <span className="truncate font-medium">{widget.name}</span>
            <span className="sr-only">{t("fragments.openFull")}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
