import { useCallback, useLayoutEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from "@shared/app-settings"
import { useAppSettings } from "@/src/stores/app-settings"

/**
 * Drag handle of the right edge of the sidebar.
 *
 * The width is a setting (`AppSettings.sidebarWidth`) and the one that applies it is
 * this component: it writes straight into the CSS variable `--sidebar-width` of the sidebar
 * wrapper, which is what sizes the gap (the space reserved in the layout) and the
 * fixed panel. During the drag this avoids a render per frame — the final
 * value only then goes to the settings.
 *
 * The component stays MOUNTED even when it is not draggable: it is the one that applies the
 * saved width, and the sidebar needs to open already at the chosen size.
 */

/** The sidebar wrapper owns the CSS variable (data-slot of ui/sidebar). */
function findWrapper(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('[data-slot="sidebar-wrapper"]')
}

interface SidebarResizeHandleProps {
  /**
   * Draggable only with the sidebar pinned. In hover mode it closes when the mouse
   * leaves and the drag would be lost in the middle.
   */
  active?: boolean
}

export function SidebarResizeHandle({ active = true }: SidebarResizeHandleProps) {
  const { t } = useTranslation()
  const width = useAppSettings((s) => s.settings.sidebarWidth)
  const handleRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // The saved width applies already on the first paint — with an ordinary effect the sidebar
  // would show up at the default and only then shrink to the chosen size.
  useLayoutEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    findWrapper(handle)?.style.setProperty("--sidebar-width", `${width}px`)
  }, [width])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!active || e.button !== 0) return
      const handle = e.currentTarget
      const wrapper = findWrapper(handle)
      if (!wrapper) return
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      dragging.current = true

      // The gap and the panel animate the width in 200ms (open/close): during the
      // drag every frame would become a delayed animation, so the transition
      // leaves the scene and comes back at the end.
      const animated = [
        wrapper.querySelector<HTMLElement>('[data-slot="sidebar-gap"]'),
        wrapper.querySelector<HTMLElement>('[data-slot="sidebar-container"]'),
      ].filter((node): node is HTMLElement => node !== null)
      for (const node of animated) node.style.transitionProperty = "none"
      const previousCursor = document.body.style.cursor
      document.body.style.cursor = "col-resize"

      const startX = e.clientX
      // The starting width is the one of the SIDEBAR (the gap it reserves in the layout),
      // not the one of the wrapper — it wraps the whole app, and measuring it made the
      // first movement jump to the ceiling, as if the width were fixed.
      const gap = wrapper.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')
      const startWidth =
        gap?.getBoundingClientRect().width ||
        Number.parseFloat(getComputedStyle(wrapper).getPropertyValue("--sidebar-width")) ||
        useAppSettings.getState().settings.sidebarWidth
      const widthAt = (clientX: number) => clampSidebarWidth(startWidth + (clientX - startX))

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return
        wrapper.style.setProperty("--sidebar-width", `${widthAt(ev.clientX)}px`)
      }

      const onEnd = (ev: PointerEvent) => {
        if (!dragging.current) return
        dragging.current = false
        handle.removeEventListener("pointermove", onMove)
        handle.removeEventListener("pointerup", onEnd)
        handle.removeEventListener("pointercancel", onEnd)
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
        for (const node of animated) node.style.transitionProperty = ""
        document.body.style.cursor = previousCursor
        // React takes over the variable again (effect above) and the final value
        // becomes the source of truth — the same on the next opening.
        useAppSettings.getState().update({ sidebarWidth: widthAt(ev.clientX) })
      }

      handle.addEventListener("pointermove", onMove)
      handle.addEventListener("pointerup", onEnd)
      handle.addEventListener("pointercancel", onEnd)
    },
    [active],
  )

  // Double click goes back to the usual size: without that there would be no way to undo it.
  const onDoubleClick = useCallback(() => {
    useAppSettings.getState().update({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH })
  }, [])

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={active ? t("sidebar.resize") : undefined}
      title={active ? t("sidebar.resize") : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={active ? onDoubleClick : undefined}
      className={
        active
          ? "group/handle absolute inset-y-0 right-0 z-20 flex w-2 cursor-col-resize touch-none items-center justify-center"
          : "pointer-events-none absolute inset-y-0 right-0 opacity-0"
      }
    >
      <div className="pointer-events-none h-8 w-0.5 rounded-full bg-transparent transition-colors group-hover/handle:bg-border" />
    </div>
  )
}
