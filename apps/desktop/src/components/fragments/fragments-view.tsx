import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { NATIVE_FRAGMENT } from "@/src/lib/native-widgets"
import { setFragmentClaimer } from "@/src/stores/panel-store"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { useWidgetPanelStore } from "@/src/stores/widget-panel-store"
import { FragmentGallery } from "./fragment-gallery"
import { FragmentScreen } from "./fragment-screen"
import { WidgetsTab } from "./widgets-tab"

/**
 * The Fragments page (sidebar): a library and one fragment at a time.
 *
 *   gallery  →  [a fragment]  →  fragment screen (header, live frame, edit mode)
 *      ↑                                │
 *      └─────────── [back] ←────────────┘
 *
 * Two tabs: the fragments themselves, and the widgets they offer (the board beside the
 * chat). A widget is not a fragment — it is a small render a fragment declares — so it
 * gets its own tab instead of a card in the gallery.
 *
 * There is no creation screen here: a fragment is created in a normal chat with the
 * fragment agent (the gallery's "new" opens one), and the page is where the fragments
 * are found, opened and edited afterwards.
 *
 * While the page is mounted it takes over the "fragment" events of the fragment it
 * shows, so the same fragment is not also opened as a side-panel tab.
 */
export function FragmentsView() {
  const { t } = useTranslation()
  const activeId = useFragmentsStore((s) => s.activeId)
  const load = useFragmentsStore((s) => s.load)
  const items = useFragmentsStore((s) => s.items)
  const section = useWidgetPanelStore((s) => s.section)
  const setSection = useWidgetPanelStore((s) => s.setSection)

  useEffect(() => {
    void load()
    setFragmentClaimer((event) => useFragmentsStore.getState().claim(event))
    return () => setFragmentClaimer(null)
  }, [load])

  const widgetCount =
    items.reduce((total, fragment) => total + fragment.widgets.length, 0) + NATIVE_FRAGMENT.widgets.length

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {activeId ? (
        <FragmentScreen key={activeId} fragmentId={activeId} />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-5 border-b border-border px-4">
            <button
              type="button"
              onClick={() => setSection("fragments")}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 py-2 text-xs transition-colors",
                section === "fragments"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t("widgets.tabs.fragments")}
              <span className="rounded border border-border px-1 text-[9px] text-muted-foreground">{items.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setSection("widgets")}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 py-2 text-xs transition-colors",
                section === "widgets"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t("widgets.tabs.widgets")}
              <span className="rounded border border-border px-1 text-[9px] text-muted-foreground">{widgetCount}</span>
            </button>
          </div>
          {section === "widgets" ? <WidgetsTab /> : <FragmentGallery />}
        </>
      )}
    </div>
  )
}
