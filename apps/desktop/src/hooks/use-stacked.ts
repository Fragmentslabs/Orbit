import { useLayoutEffect, useState } from "react"

/** How long the width has to stay put before the layout changes (the sidebar animates). */
const SETTLE_MS = 160

/**
 * Whether an element is too narrow for the page to keep two columns, by ITS OWN width — the
 * side panel and the sidebar eat it, not only the window. The first measure counts at once;
 * the next ones wait for the width to settle, because opening the sidebar slides the width
 * through the threshold for a fraction of a second and changing the whole layout on each frame
 * made the screen flicker (the flexible columns just follow the animation until then).
 */
export function useStacked(element: HTMLElement | null, belowPx: number): boolean {
  const [stacked, setStacked] = useState(false)
  useLayoutEffect(() => {
    if (!element) return
    setStacked(element.clientWidth < belowPx)
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setStacked(element.clientWidth < belowPx), SETTLE_MS)
    })
    observer.observe(element)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [element, belowPx])
  return stacked
}
