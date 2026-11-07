import { useEffect, useRef, useState } from "react"
import type { FragmentManifest } from "@shared/fragments"
import { cn } from "@/lib/utils"
import { FragmentFrame } from "@/src/components/fragment-tab"

/** The size the thumbnail renders the page at before shrinking it — a plausible desktop viewport. */
const PAGE_W = 1100
const PAGE_H = 690

/**
 * A live thumbnail of a fragment: the real page, scaled to the card, read-only.
 *
 * It mounts only once it scrolls into view (a gallery of twenty fragments must not run
 * twenty pages at once) and `FragmentFrame` is in `preview` mode, so the page can
 * not call Orbit from a card. The scale follows the card's width.
 */
export function FragmentPreview({
  manifest,
  pageWidth = PAGE_W,
  pageHeight = PAGE_H,
  readOnly = false,
  fit = "card",
}: {
  manifest: FragmentManifest
  /** The size the page renders at before scaling: a widget is laid out small, a screen like a desktop. */
  pageWidth?: number
  pageHeight?: number
  /** Let the page read what it saved (a home-screen widget), instead of being a pure picture. */
  readOnly?: boolean
  /** `card`: a fixed-height thumbnail. `aspect`: the height follows the page's proportions. */
  fit?: "card" | "aspect"
}) {
  const box = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [scale, setScale] = useState(0.3)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setScale(el.clientWidth / pageWidth)
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    const seen = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), { rootMargin: "120px" })
    seen.observe(el)
    return () => {
      resize.disconnect()
      seen.disconnect()
    }
  }, [pageWidth])

  return (
    <div
      ref={box}
      className={cn("relative w-full overflow-hidden bg-muted/40", fit === "card" && "h-36")}
      style={fit === "aspect" ? { aspectRatio: `${pageWidth} / ${pageHeight}` } : undefined}
      aria-hidden
    >
      {visible && (
        <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ width: pageWidth, height: pageHeight, transform: `scale(${scale})` }}>
          <FragmentFrame manifest={manifest} reloads={0} preview={!readOnly} readOnly={readOnly} className="size-full border-0 bg-white" />
        </div>
      )}
    </div>
  )
}
