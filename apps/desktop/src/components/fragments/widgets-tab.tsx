import { useMemo, useRef, useState, type DragEvent } from "react"
import { useTranslation } from "react-i18next"
import { ChevronLeft, ChevronRight, LayoutGrid, Orbit, Plus, Puzzle, Sparkles, Trash2, X } from "lucide-react"
import {
  FRAGMENT_WIDGET_GAP,
  FRAGMENT_WIDGET_UNIT,
  type FragmentManifest,
  type FragmentWidget,
  type FragmentWidgetSize,
} from "@shared/fragments"
import { cn } from "@/lib/utils"
import { FilterChips, FilterRail, type FilterOption } from "@/src/components/filter-rail"
import { FragmentFrame } from "@/src/components/fragment-tab"
import { NativeWidgetFrame } from "@/src/components/widgets/native/native-widget-frame"
import {
  isNativeFragment,
  NATIVE_FRAGMENT,
  nativeWidgetDescription,
  nativeWidgetName,
} from "@/src/lib/native-widgets"
import {
  biggestSize,
  boardHeight,
  boardRows,
  boxToSize,
  cellAt,
  dropTarget,
  layoutWidgetBoard,
  onPage,
  sizeToBox,
  sizesLargestFirst,
  widgetsLargestFirst,
  type BoardItem,
} from "@/src/lib/widget-board"
import { useStacked } from "@/src/hooks/use-stacked"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { MAX_PAGES, useWidgetPanelStore } from "@/src/stores/widget-panel-store"
import { FragmentIcon } from "./fragment-icon"
import { WidgetPreview } from "./widget-preview"

const UNIT = FRAGMENT_WIDGET_UNIT
const GAP = FRAGMENT_WIDGET_GAP
const BOARD_W = UNIT * 2 + GAP

/** The library draws the sizes smaller: it is an index, not the board. */
const LIB_UNIT = 46

/** Where the library's widgets come from. */
type WidgetSource = "all" | "native" | "fragments"

/** What a drag carries, whether it comes from the library or from a card already on the board. */
interface DragPayload {
  fragmentId: string
  widgetId: string
  size?: FragmentWidgetSize
  /** Index on the board it came from; null when it comes from the library. */
  from: number | null
}

function libBox(size: FragmentWidgetSize): { width: number; height: number } {
  const { cols, rows } = sizeToBox(size)
  return { width: cols * LIB_UNIT + (cols - 1) * 6, height: rows * LIB_UNIT + (rows - 1) * 6 }
}

function boxOf(item: BoardItem): { left: number; top: number; width: number; height: number } {
  return {
    left: item.col * (UNIT + GAP),
    top: item.row * (UNIT + GAP),
    width: item.cols * UNIT + (item.cols - 1) * GAP,
    height: item.rows * UNIT + (item.rows - 1) * GAP,
  }
}


/**
 * The Widgets tab of the Fragments page.
 *
 * Left: what the fragments OFFER, grouped by fragment — click to put a copy on the board,
 * drag it into the grid to choose where. Right: the board itself, exactly the grid that
 * appears beside the chat. The cards there are the real ones: drag to move, click to edit
 * the size, ask for a change or take it off, without leaving the board.
 *
 * The board is the person's; a fragment only offers.
 */
export function WidgetsTab() {
  const { t } = useTranslation()
  const items = useFragmentsStore((s) => s.items)
  const placements = useWidgetPanelStore((s) => s.placements)
  const add = useWidgetPanelStore((s) => s.add)
  const insert = useWidgetPanelStore((s) => s.insert)
  const removeAt = useWidgetPanelStore((s) => s.removeAt)
  const setSize = useWidgetPanelStore((s) => s.setSize)
  const placeAt = useWidgetPanelStore((s) => s.placeAt)
  const page = useWidgetPanelStore((s) => s.page)
  const pages = useWidgetPanelStore((s) => s.pages)
  const setPage = useWidgetPanelStore((s) => s.setPage)
  const addPage = useWidgetPanelStore((s) => s.addPage)
  const removePage = useWidgetPanelStore((s) => s.removePage)

  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  // Below this the rail would leave the catalogue a strip of cells: the filters become chips
  // and the board editor waits for a window with room for it.
  const stacked = useStacked(root, 760)
  const [drag, setDrag] = useState<DragPayload | null>(null)
  const [dropCell, setDropCell] = useState<{ col: number; row: number } | null>(null)
  // By the card's index in the full list, not by the widget: two copies of the same widget
  // are two cards, and selecting one must not light up the other.
  const [selected, setSelected] = useState<number | null>(null)
  const [source, setSource] = useState<WidgetSource>("all")
  // Whether the card in the hand was let go over the board. The drop sets it and dragend
  // reads it: a card released anywhere else leaves the board.
  const droppedOnBoard = useRef(false)

  const allOffering = useMemo(() => [NATIVE_FRAGMENT, ...items.filter((f) => f.widgets.length > 0)], [items])
  const offering = useMemo(
    () =>
      allOffering.filter((fragment) =>
        source === "all" ? true : source === "native" ? isNativeFragment(fragment.id) : !isNativeFragment(fragment.id),
      ),
    [allOffering, source],
  )
  const fragments = useMemo(() => new Map([NATIVE_FRAGMENT, ...items].map((f) => [f.id, f])), [items])
  const counts = useMemo(
    () => ({
      all: NATIVE_FRAGMENT.widgets.length + items.reduce((sum, fragment) => sum + fragment.widgets.length, 0),
      native: NATIVE_FRAGMENT.widgets.length,
      fragments: items.reduce((sum, fragment) => sum + fragment.widgets.length, 0),
    }),
    [items],
  )
  const sourceOptions = useMemo<FilterOption<WidgetSource>[]>(
    () => [
      { value: "all", label: t("widgets.filters.all"), icon: LayoutGrid, count: counts.all },
      { value: "native", label: t("widgets.filters.native"), icon: Orbit, count: counts.native },
      { value: "fragments", label: t("widgets.filters.fragments"), icon: Puzzle, count: counts.fragments },
    ],
    [counts, t],
  )

  const widgetOf = useMemo(
    () => (placement: { fragmentId: string; widgetId: string }) =>
      fragments.get(placement.fragmentId)?.widgets.find((w) => w.id === placement.widgetId),
    [fragments],
  )

  const board = useMemo(() => layoutWidgetBoard(placements, widgetOf, undefined, page), [placements, widgetOf, page])
  /** What the page showing holds — the board, the count and the empty state all read this. */
  const pagePlacements = useMemo(() => onPage(placements, page), [placements, page])
  // The board has exactly the rows the cards use (see boardRows). While a card is in the air
  // it opens the room that card needs below the last row — two rows for a 2x2 — so it can
  // always be dropped at the bottom without being squeezed into a size it did not ask for.
  const rows = useMemo(() => boardRows(pagePlacements), [pagePlacements])
  const draggedWidget = drag ? widgetOf(drag) : undefined
  const dropRows = drag
    ? rows + Math.max(1, sizeToBox(drag.size ?? (draggedWidget ? biggestSize(draggedWidget) : "1x1")).rows)
    : rows

  const selectedItem = selected != null ? board.find((item) => item.index === selected) : undefined
  const selectedFragment = selectedItem ? fragments.get(selectedItem.placement.fragmentId) : undefined
  const selectedWidget = selectedItem
    ? selectedFragment?.widgets.find((w) => w.id === selectedItem.placement.widgetId)
    : undefined

  /**
   * Where the dragged card would land — and at which size — drawn while it hovers the
   * board. The drop reads the SAME answer (see onBoardDrop), so the guide never promises a
   * size the drop then ignores.
   */
  const ghost = useMemo(
    () => (drag && dropCell ? dropTarget(placements, widgetOf, drag, dropCell, dropRows, page) : null),
    [drag, dropCell, dropRows, page, placements, widgetOf],
  )

  const endDrag = () => {
    setDrag(null)
    setDropCell(null)
  }

  /** Switching pages drops the selection: the selected card lives on one page only. */
  const changePage = (next: number) => {
    setSelected(null)
    setPage(next)
  }

  const startFromLibrary = (event: DragEvent<HTMLButtonElement>, fragment: FragmentManifest, widget: FragmentWidget) => {
    const payload: DragPayload = { fragmentId: fragment.id, widgetId: widget.id, size: biggestSize(widget), from: null }
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", JSON.stringify(payload))
    droppedOnBoard.current = false
    setSelected(null)
    setDrag(payload)
    setDropCell(null)
  }

  const startFromBoard = (event: DragEvent<HTMLButtonElement>, item: BoardItem) => {
    const payload: DragPayload = {
      fragmentId: item.placement.fragmentId,
      widgetId: item.placement.widgetId,
      size: item.placement.size,
      from: item.index,
    }
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", JSON.stringify(payload))
    droppedOnBoard.current = false
    setSelected(null)
    setDrag(payload)
    setDropCell(null)
  }

  const onBoardDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!drag) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    const rect = event.currentTarget.getBoundingClientRect()
    setDropCell(cellAt(event.clientX - rect.left, event.clientY - rect.top, dropRows))
  }

  const onBoardDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropCell(null)
  }

  const onBoardDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    droppedOnBoard.current = true
    const payload = drag
    const cell = dropCell
    if (!payload || !cell) {
      endDrag()
      return
    }
    // The drop keeps exactly what the guide showed: the cell, and the size the layout
    // resolved there — a declared size smaller than the one in the hand, when that is what
    // fits beside the neighbours.
    const landing = dropTarget(placements, widgetOf, payload, cell, dropRows, page)
    const col = landing?.col ?? cell.col
    const row = landing?.row ?? cell.row
    const size = landing?.placement.size ?? payload.size
    endDrag()
    if (payload.from != null) placeAt(payload.from, col, row, size)
    else insert(placements.length, payload.fragmentId, payload.widgetId, size, col, row)
    setSelected(landing?.index ?? null)
  }

  /**
   * Letting go anywhere that is not the board takes the card off it — the same gesture as
   * pulling an icon out of a dock. A drop ON the board is a move (onBoardDrop already did
   * it); a card that came from the library only ever lands.
   */
  const onCardDragEnd = () => {
    const payload = drag
    const landed = droppedOnBoard.current
    droppedOnBoard.current = false
    endDrag()
    if (payload?.from != null && !landed) {
      removeAt(payload.from)
      setSelected(null)
    }
  }

  /** Every click puts one more copy on the board: the same widget may sit twice, on any page. */
  const addWidget = (fragment: FragmentManifest, widget: FragmentWidget) => {
    add(fragment.id, widget.id, biggestSize(widget))
  }

  const removeSelected = () => {
    if (!selectedItem) return
    removeAt(selectedItem.index)
    setSelected(null)
  }

  /** What the selected widget shows right now — what the preview and the request use. */
  const selectedSize =
    selectedItem && selectedWidget ? (selectedItem.placement.size ?? biggestSize(selectedWidget)) : undefined

  /**
   * "Ask for a change in chat": the widget becomes an attachment of the fragment's own
   * composer (the chip above the input) and the page goes to that fragment in edit mode —
   * the change is asked where the fragment is edited, without repeating which widget it is.
   */
  const requestChange = () => {
    if (!selectedItem || !selectedFragment || !selectedWidget) return
    usePanelStore.getState().addQuote({
      kind: "widget",
      fragmentId: selectedFragment.id,
      fragmentName: selectedFragment.name,
      widgetId: selectedWidget.id,
      name: selectedWidget.name,
      size: selectedSize ?? biggestSize(selectedWidget),
      sizes: selectedWidget.sizes,
    })
    const fragments = useFragmentsStore.getState()
    fragments.open(selectedFragment.id)
    fragments.toggleEditing()
  }

  return (
    <div ref={setRoot} className={cn("flex min-h-0 flex-1 overflow-hidden", stacked && "flex-col")}>
      {stacked && (
        <FilterChips
          className="shrink-0 px-4 pt-3"
          options={sourceOptions}
          value={source}
          onChange={setSource}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {offering.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <LayoutGrid className="size-5 text-muted-foreground" />
            <p className="max-w-sm text-xs text-muted-foreground">{t("widgets.tab.empty")}</p>
          </div>
        ) : (
          <>
            <p className="mb-4 max-w-xl text-xs text-muted-foreground">{t("widgets.tab.hint")}</p>
            <div className="flex flex-col gap-5">
              {offering.map((fragment) => (
                <section key={fragment.id}>
                  <header className="mb-2 flex items-center gap-1.5">
                    <FragmentIcon name={fragment.icon} className="size-3.5 text-primary" />
                    <span className="text-xs font-medium">{fragment.name}</span>
                    {isNativeFragment(fragment.id) && (
                      <span className="rounded-full bg-primary/10 px-1.5 text-[9px] font-medium text-primary">
                        {t("widgets.native.badge")}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {fragment.widgets.length} · widget
                    </span>
                  </header>
                  <div className="flex flex-wrap items-start gap-3">
                    {widgetsLargestFirst(fragment.widgets).map((widget) => {
                      const size = biggestSize(widget)
                      const box = libBox(size)
                      return (
                        <button
                          key={widget.id}
                          type="button"
                          draggable
                          onDragStart={(event) => startFromLibrary(event, fragment, widget)}
                          onDragEnd={endDrag}
                          onClick={() => addWidget(fragment, widget)}
                          className="group flex w-[124px] cursor-grab flex-col items-start gap-1 text-left active:cursor-grabbing"
                          title={nativeWidgetDescription(widget, t) || widget.name}
                        >
                          <span
                            className="relative flex items-center justify-center overflow-hidden rounded-lg border border-dashed border-border transition-colors group-hover:border-primary/40"
                            style={box}
                          >
                            <WidgetPreview fragment={fragment} widget={widget.id} size={size} unit={LIB_UNIT} />
                            <span className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-card/90 text-muted-foreground opacity-0 shadow transition-opacity group-hover:opacity-100">
                              <Plus className="size-2.5" />
                            </span>
                            <span className="absolute bottom-0.5 right-1 rounded bg-card/85 px-1 text-[8px] text-muted-foreground">
                              {size}
                            </span>
                          </span>
                          <span className="line-clamp-1 text-[11px] font-medium">{nativeWidgetName(widget, t)}</span>
                          <span className="text-[9px] text-muted-foreground">{sizesLargestFirst(widget).join(" · ")}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>

      <aside
        className={cn(
          "flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3",
          stacked && "hidden",
        )}
      >
        <FilterRail
          title={t("widgets.filters.title")}
          count={counts.all}
          countLabel={t("widgets.filters.count")}
          options={sourceOptions}
          value={source}
          onChange={setSource}
          hint={
            source === "native"
              ? t("widgets.filters.hintNative")
              : source === "fragments"
                ? t("widgets.filters.hintFragments")
                : t("widgets.filters.hintAll")
          }
        />

        <div className="h-px shrink-0 bg-border" />

        <div className="flex items-center gap-1.5">
          <LayoutGrid className="size-3.5 text-primary" />
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("widgets.tab.preview")}
          </span>
        </div>

        <div className="mx-auto rounded-xl border border-border bg-background p-2">
          <div
            className="relative"
            style={{ width: BOARD_W, height: boardHeight(dropRows) }}
            onDragOver={onBoardDragOver}
            onDragLeave={onBoardDragLeave}
            onDrop={onBoardDrop}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-60"
              style={{
                backgroundImage: "radial-gradient(circle at 1px 1px, var(--border) 1px, transparent 0)",
                backgroundSize: `${UNIT + GAP}px ${UNIT + GAP}px`,
              }}
            />

            {board.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-3">
                <span className="text-center text-[10px] leading-relaxed text-muted-foreground">
                  {t("widgets.tab.drop")}
                </span>
              </div>
            )}

            {ghost && (
              <div
                className="pointer-events-none absolute rounded-lg border-2 border-dashed border-primary/70 bg-primary/10"
                style={boxOf(ghost)}
              />
            )}

            {board.map((item) => {
              const fragment = fragments.get(item.placement.fragmentId)
              if (!fragment) return null
              const widget = fragment.widgets.find((w) => w.id === item.placement.widgetId)
              const isSelected = selected === item.index
              const isDragged = drag?.from === item.index
              const box = boxOf(item)
              return (
                <button
                  key={item.index}
                  type="button"
                  draggable
                  onDragStart={(event) => startFromBoard(event, item)}
                  onDragEnd={onCardDragEnd}
                  onClick={() => setSelected(isSelected ? null : item.index)}
                  title={widget ? nativeWidgetName(widget, t) : fragment.name}
                  className={cn(
                    "absolute overflow-hidden rounded-lg border bg-card text-left transition-colors",
                    isSelected ? "border-primary ring-2 ring-primary/40" : "border-border/70 hover:border-primary/60",
                    isDragged && "opacity-30",
                  )}
                  style={box}
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
                  <span className="absolute inset-0 cursor-grab active:cursor-grabbing" aria-hidden />
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => changePage(page - 1)}
            disabled={page === 0}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            title={t("widgets.tab.previousPage")}
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <div className="flex items-center gap-1">
            {Array.from({ length: pages }, (_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => changePage(index)}
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
            onClick={() => changePage(page + 1)}
            disabled={page === pages - 1}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            title={t("widgets.tab.nextPage")}
          >
            <ChevronRight className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={addPage}
            disabled={pages >= MAX_PAGES}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            title={t("widgets.tab.addPage")}
          >
            <Plus className="size-3.5" />
          </button>
          {pagePlacements.length === 0 && pages > 1 && (
            <button
              type="button"
              onClick={removePage}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title={t("widgets.tab.removePage")}
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {selectedItem && selectedFragment && selectedWidget ? (
          <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-card p-2">
            <div className="flex items-center gap-1.5">
              <FragmentIcon name={selectedFragment.icon} className="size-3.5 text-primary" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                {nativeWidgetName(selectedWidget, t)}
              </span>
              <button
                type="button"
                onClick={removeSelected}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                title={t("widgets.tab.remove")}
              >
                <Trash2 className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("widgets.tab.close")}
              >
                <X className="size-3" />
              </button>
            </div>

            {/* The widget at its OWN size: the reason this panel exists — deciding the size
                without guessing what it looks like. */}
            <div className="flex items-center justify-center rounded-lg border border-border bg-background py-2">
              <WidgetPreview
                fragment={selectedFragment}
                widget={selectedWidget.id}
                size={selectedSize ?? biggestSize(selectedWidget)}
                unit={UNIT}
              />
            </div>

            <div className="flex gap-1">
              {sizesLargestFirst(selectedWidget).map((size) => {
                const { cols, rows } = sizeToBox(size)
                const current = size === (selectedSize ?? biggestSize(selectedWidget))
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setSize(selectedItem.index, size)}
                    className={cn(
                      "flex flex-1 flex-col items-center gap-1 rounded-md border py-1.5 transition-colors",
                      current
                        ? "border-primary/60 bg-primary/15"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "rounded-[3px] border-[1.5px]",
                        current ? "border-primary" : "border-muted-foreground/60",
                      )}
                      style={{ width: cols * 12 + (cols - 1) * 2, height: rows * 12 + (rows - 1) * 2 }}
                    />
                    <span className={cn("text-[9px]", current ? "text-foreground" : "text-muted-foreground")}>{size}</span>
                  </button>
                )
              })}
            </div>

            {isNativeFragment(selectedFragment.id) ? (
              <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">{t("widgets.native.hint")}</p>
            ) : (
              <button
                type="button"
                onClick={requestChange}
                className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-primary/50 bg-primary/10 text-[10px] font-medium transition-colors hover:bg-primary/20"
              >
                <Sparkles className="size-3 text-primary" />
                {t("widgets.tab.requestChange")}
              </button>
            )}
          </div>
        ) : drag?.from != null ? (
          <p className="text-[10px] leading-relaxed text-muted-foreground">{t("widgets.tab.dragOut")}</p>
        ) : (
          <p className="text-[10px] leading-relaxed text-muted-foreground">{t("widgets.tab.select")}</p>
        )}
      </aside>
    </div>
  )
}
