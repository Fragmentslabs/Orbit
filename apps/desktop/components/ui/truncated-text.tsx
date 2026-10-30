import { cloneElement, useEffect, useRef, useState, type ReactElement } from "react"

import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"

type Side = "top" | "right" | "bottom" | "left"

/**
 * Measures a single-line element and tells whether the text is cut.
 *
 * The decision comes from scrollWidth/clientWidth and is re-evaluated on resize — never
 * from the size of the string, which depends on the font and the language.
 */
function useTruncated(text?: string) {
  const ref = useRef<HTMLElement>(null)
  const [state, setState] = useState({ truncated: false, text: text ?? "" })

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const measure = () =>
      setState({
        truncated: element.scrollWidth > element.clientWidth + 1,
        // Without an explicit `text`, the label is the content of the element itself —
        // which is what the user could not read.
        text: text ?? (element.textContent ?? "").trim(),
      })
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])

  return { ref, ...state }
}

interface TruncateProps {
  /** Optional: without it, the label is the `textContent` of the element. */
  text?: string
  side?: Side
  /** The element that already cuts — it is the one measured, the layout does not change. */
  children: ReactElement<Record<string, unknown>>
}

/**
 * Wraps an element that ALREADY cuts (`truncate`) and only opens the tooltip when the
 * text is in fact cut.
 *
 * It is the path for what already exists: nothing is rewritten, only wrapped, and the measurement
 * comes from the element itself. It requires the element to accept `ref` — DOM tag or
 * component that forwards it (Badge, Button). A component that does not forward degrades
 * silently: no ref, no tooltip.
 */
function Truncate({ text, side = "top", children }: TruncateProps) {
  const { ref, truncated, text: label } = useTruncated(text)

  return (
    <Hint label={label} side={side} disabled={!truncated || !label} injectName={false}>
      {cloneElement(children, { ref } as Record<string, unknown>)}
    </Hint>
  )
}

interface TruncatedTextProps {
  text: string
  className?: string
  side?: Side
}

/**
 * Single-line text that gets a tooltip **only when it is cut**.
 *
 * Tab title, file name, session name: the `max-w` is what keeps the
 * list breathing, but the snippet left on the screen stops identifying the item.
 * For an element that already exists and cannot be swapped, use `Truncate`.
 */
function TruncatedText({ text, className, side = "top" }: TruncatedTextProps) {
  return (
    <Truncate      text={text} side={side}>
      <span className={cn("block min-w-0 truncate", className)}>{text}</span>
    </Truncate>
  )
}

export { Truncate, TruncatedText }
