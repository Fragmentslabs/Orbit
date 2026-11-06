import { useLayoutEffect, useState } from "react"

/**
 * Extra width a page needs to leave the stacked layout once it is in it. Without it, a width that
 * hovers around the threshold (a drag that stops there, a sidebar animation) would flip the layout
 * on every frame.
 */
const HYSTERESIS_PX = 32

/**
 * Whether an element is too narrow for the page to keep two columns, by ITS OWN width — the
 * side panel and the sidebar eat it, not only the window. It follows the width live (while a
 * resizable handle is being dragged, not only when it is released); the hysteresis is what keeps
 * it from flickering at the threshold.
 */
export function useStacked(element: HTMLElement | null, belowPx: number): boolean {
  const [stacked, setStacked] = useState(false)
  useLayoutEffect(() => {
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      setStacked((was) => (was ? width < belowPx + HYSTERESIS_PX : width < belowPx))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, belowPx])
  return stacked
}
