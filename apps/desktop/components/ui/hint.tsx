import type { ReactElement } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface HintProps {
  /** Label of the control. It becomes the tooltip and the accessible name. */
  label: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  /** Does not open the tooltip — for text that only needs it when it is cut. */
  disabled?: boolean
  /** Does not inject `aria-label`: for text already visible, whose name comes from the content. */
  injectName?: boolean
  /** The controlled element: a <button>, a <Button>, a <span>. */
  children: ReactElement
}

/**
 * Label of a control that has no visible text.
 *
 * Orbit does not use the native `title`: on macOS it takes about a second, does not
 * follow the theme and never shows up on touch. This wrapper delivers the three things at
 * once — the app's tooltip, the `aria-label` and the name the screen reader
 * announces — without touching the visuals of the element, which keeps being what the
 * caller passed.
 *
 * The `aria-label` is only injected when the element does not bring its own, so as not to
 * overwrite a more specific hand-written name.
 *
 * NEVER pass a `Hint` as the `render` element of another trigger (`render={<Hint …><button/>}</Hint>`).
 * Base UI merges the render element's own props and children over the trigger's, and this
 * component only reads the props it knows: the trigger's handlers, its ref, its id and its
 * children are all dropped — the button comes out empty, unclickable and, in a toolbar,
 * invisible. Compose the other way around: `<Hint…><DropdownMenuTrigger
 * render={<button>{content}</button>} /></Hint>` — then both triggers end up on the same node.
 */
function Hint({ label, side = "top", align, disabled, injectName = true, children }: HintProps) {
  if (!label) return children

  const hasName = Boolean((children.props as { "aria-label"?: string })?.["aria-label"])
  const name = injectName && !hasName ? { "aria-label": label } : {}

  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={children} {...name} />
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export { Hint }
