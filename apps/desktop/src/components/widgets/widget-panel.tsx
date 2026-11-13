import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeft, ChevronRight, Pin, Settings2 } from "lucide-react"
import { FRAGMENT_WIDGET_GAP, FRAGMENT_WIDGET_UNIT } from "@shared/fragments"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { FragmentFrame } from "@/src/components/fragment-tab"
import { NativeWidgetFrame } from "@/src/components/widgets/native/native-widget-frame"
import { isNativeFragment, NATIVE_FRAGMENT, nativeWidgetDestination, nativeWidgetName } from "@/src/lib/native-widgets"
import { boardExtent, boxToSize, layoutWidgetBoard } from "@/src/lib/widget-board"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useWidgetPanelStore } from "@/src/stores/widget-panel-store"

const UNIT = FRAGMENT_WIDGET_UNIT
const GAP = FRAGMENT_WIDGET_GAP
/** Narrowest the panel gets: the two buttons still need room when nothing fits on the board. */
const MIN_PANEL_W = 84

/** Hover opens after a beat (so crossing the edge on the way to something else does not flash) and closes a beat later. */
const SHOW_DELAY = 150
const HIDE_DELAY = 220

/**
 * The widget board beside the chat: a rail on the right edge that expands into a grid of
 * small live widgets — two columns, and as many rows as the board uses (six by default,
 * more when cards are placed below them), only as big as what is actually placed.
 *
 * It only exists while the side panel is closed — with the panel open the two would
 * fight for the same strip, and the panel already shows the full fragment. Each cell is
 * the fragment's own page loaded with `?widget=<id>&size=<size>` (read-only), and a click
 * opens the fragment, which closes the board by opening the side panel.
 */
export function WidgetPanel() {
  const { t } = useTranslation()
  const items = useFragmentsStore((s) => s.items)
  const loaded = useFragmentsStore((s) => s.loaded)
  const load = useFragmentsStore((s) => s.load)
  const placements = useWidgetPanelStore((s) => s.placements)
  const pinnedOpen = useWidgetPanelStore((s) => s.open)
  const toggle = useWidgetPanelStore((s) => s.toggle)
  const openFragmentTab = usePanelStore((s) => s.openFragmentTab)
  const { setView } = useWorkspace()
  const setSection = useWidgetPanelStore((s) => s.setSection)
  const page = useWidgetPanelStore((s) => s.page)
  const pages = useWidgetPanelStore((s) => s.pages)
  const setPage = useWidgetPanelStore((s) => s.setPage)

  const [hovered, setHovered] = useState(false)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
    },
    [],
  )

  const fragments = useMemo(() => new Map([NATIVE_FRAGMENT, ...items].map((f) => [f.id, f])), [items])

  const board = useMemo(
    () =>
      layoutWidgetBoard(
        placements,
        (placement) => fragments.get(placement.fragmentId)?.widgets.find((widget) => widget.id === placement.widgetId),
        undefined,
        page,
      ),
    [page, placements, fragments],
  )

  if (placements.length === 0) return null

  const extent = boardExtent(board)
  const expanded = pinnedOpen || hovered

  const enter = () => {
    window.clearTimeout(hideTimer.current)
    window.clearTimeout(showTimer.current)
    showTimer.current = window.setTimeout(() => setHovered(true), SHOW_DELAY)
  }
  const leave = () => {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setHovered(false), HIDE_DELAY)
  }

  const openSettings = () => {
    setSection("widgets")
    setView("fragments")
    setHovered(false)
  }

  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-7 z-30 flex items-start pt-16"
      aria-label={t("widgets.panel.label")}
    >
      <div
        className="pointer-events-auto flex items-center"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocusCapture={enter}
        onBlurCapture={leave}
      >
        {expanded ? (
          <div
            className="flex max-h-[calc(100vh-8rem)] flex-col gap-1.5 overflow-y-auto overflow-x-hidden rounded-2xl border border-border bg-card/95 p-1.5 shadow-xl backdrop-blur [scrollbar-gutter:stable]"
            // 12px of padding + the 6px scrollbar gutter the card always reserves: the board
            // (extent.width) has to fit even while the vertical scrollbar is showing, or the
            // card grows a horizontal one.
            style={{ width: Math.max(extent.width + 18, MIN_PANEL_W) }}
          >
            {/* No title and no icon: a single filled column is 72px, the name would be the only thing wider. */}
            <div className="flex items-center justify-end gap-0.5 px-0.5">
              <button
                type="button"
                onClick={openSettings}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("widgets.panel.settings")}
              >
                <Settings2 className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => toggle()}
                className={cn(
                  "rounded p-0.5 transition-colors hover:bg-accent",
                  pinnedOpen ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
                title={pinnedOpen ? t("widgets.panel.unpin") : t("widgets.panel.pin")}
              >
                <Pin className={cn("size-3.5", pinnedOpen && "fill-current")} />
              </button>
            </div>

            <div className="relative mx-auto" style={{ width: extent.width, height: extent.height }}>
              {board.map((item) => {
                const fragment = fragments.get(item.placement.fragmentId)
                const widget = fragment?.widgets.find((w) => w.id === item.placement.widgetId)
                if (!fragment) return null
                const width = item.cols * UNIT + (item.cols - 1) * GAP
                const height = item.rows * UNIT + (item.rows - 1) * GAP
                return (
                  <button
                    // The index of the placement, not the widget: the same widget may be placed
                    // twice (on one page or on two), and a repeated key left React reusing a card
                    // of the page before — still on screen, behind the new one.
                    key={item.index}
                    type="button"
                    onClick={() => {
                      if (isNativeFragment(fragment.id)) {
                        const destination = nativeWidgetDestination(item.placement.widgetId)
                        if (destination) setView(destination)
                        setHovered(false)
                        return
                      }
                      openFragmentTab({ id: fragment.id, title: fragment.name, route: widget?.destination })
                    }}
                    title={widget ? nativeWidgetName(widget, t) : fragment.name}
                    className={cn(
                      "absolute overflow-hidden rounded-xl border border-border/70 bg-card text-left",
                      "transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                    style={{
                      left: (item.col - extent.col) * (UNIT + GAP),
                      top: (item.row - extent.row) * (UNIT + GAP),
                      width,
                      height,
                    }}
                  >
                    {isNativeFragment(fragment.id) ? (
                      <NativeWidgetFrame
                        widgetId={item.placement.widgetId}
                        size={item.placement.size ?? boxToSize(item.cols, item.rows)}
                        className="pointer-events-none size-full"
                      />
                    ) : (
                      <FragmentFrame
                        manifest={fragment}
                        reloads={0}
                        readOnly
                        widget={item.placement.widgetId}
                        size={item.placement.size ?? `${item.cols}x${item.rows}`}
                        className="pointer-events-none size-full border-0 bg-card"
                      />
                    )}
                    {/* The cell is the button: the page inside never eats the click. */}
                    <span className="absolute inset-0" aria-hidden />
                  </button>
                )
              })}
            </div>

            {pages > 1 && (
              <div className="flex items-center justify-center gap-1 px-0.5">
                <button
                  type="button"
                  onClick={() => setPage(page - 1)}
                  disabled={page === 0}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  title={t("widgets.tab.previousPage")}
                >
                  <ChevronLeft className="size-3" />
                </button>
                <div className="flex items-center gap-1">
                  {Array.from({ length: pages }, (_, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => setPage(index)}
                      className={cn(
                        "size-1.5 rounded-full transition-colors",
                        index === page ? "bg-primary" : "bg-muted-foreground/30 hover:bg-muted-foreground/60",
                      )}
                      title={t("widgets.tab.page", { page: index + 1 })}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setPage(page + 1)}
                  disabled={page === pages - 1}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                  title={t("widgets.tab.nextPage")}
                >
                  <ChevronRight className="size-3" />
                </button>
              </div>
            )}

          </div>
        ) : (
          <div className="flex h-56 w-3.5 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-card/90 shadow-lg backdrop-blur transition-colors hover:bg-accent">
            <span className="[writing-mode:vertical-rl] rotate-180 text-[9px] font-medium tracking-wide text-muted-foreground">
              {t("widgets.panel.rail")}
            </span>
            <span className="text-[9px] text-muted-foreground">{board.length}</span>
          </div>
        )}
      </div>
    </div>
  )
}
