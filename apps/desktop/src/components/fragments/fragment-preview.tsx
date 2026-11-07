import { useEffect, useRef, useState } from "react"
import type { FragmentManifest } from "@shared/fragments"
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
export function FragmentPreview({ manifest }: { manifest: FragmentManifest }) {
  const box = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [scale, setScale] = useState(0.3)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setScale(el.clientWidth / PAGE_W)
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    const seen = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), { rootMargin: "120px" })
    seen.observe(el)
    return () => {
      resize.disconnect()
      seen.disconnect()
    }
  }, [])

  return (
    <div ref={box} className="relative h-36 w-full overflow-hidden bg-muted/40" aria-hidden>
      {visible && (
        <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${scale})` }}>
          <FragmentFrame manifest={manifest} reloads={0} preview className="size-full border-0 bg-white" />
        </div>
      )}
    </div>
  )
}
