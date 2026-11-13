import { useLayoutEffect, useState, type RefObject } from "react"

export type ComposerBand = "wide" | "medium" | "narrow"

export type ComposerLayout = {
  band: ComposerBand
  /** The autonomy (permission) selector is still on the row, so the single button must not repeat it. */
  permissionVisible: boolean
}

/** Width from which the thinking selector has room for its label. */
const WIDE_FROM = 576
/** Below this the individual selectors give way to the single button. */
const MEDIUM_FROM = 512
/** Width from which the autonomy (permission) selector stays in the row. */
const PERMISSION_FROM = 448

/**
 * What the composer's footer can afford at a given width: the thinking with its
 * label (wide), the thinking as an icon next to the model (medium), or a single
 * button with everything (narrow) — plus whether the autonomy selector is still on
 * the row, which decides if the single button has to carry it.
 *
 * Decided from a REAL measurement instead of container-query classes: the chat and
 * the code composer have to take the same steps at the same widths, and a class
 * that fails to apply leaves the row with the wrong buttons — or with none at all.
 */
export function composerLayoutFor(width: number): ComposerLayout {
  return {
    band: width >= WIDE_FROM ? "wide" : width >= MEDIUM_FROM ? "medium" : "narrow",
    permissionVisible: width >= PERMISSION_FROM,
  }
}

export function useComposerLayout(ref: RefObject<HTMLElement | null>): ComposerLayout {
  const [layout, setLayout] = useState<ComposerLayout>(() => composerLayoutFor(WIDE_FROM))

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const apply = (width: number) => {
      const next = composerLayoutFor(width)
      setLayout((current) =>
        current.band === next.band && current.permissionVisible === next.permissionVisible ? current : next,
      )
    }
    // Measured before the first paint, and then on every resize of the composer.
    apply(element.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width != null) apply(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return layout
}
