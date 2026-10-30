import { forwardRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * The one-line field of the shortcut panel (⇧⌘space). It is the SAME one in the
 * floating panels of Computer Use: whoever is in another app and talks to Orbit sees one
 * single way of writing, be it through the shortcut or in the conversation they are
 * controlling — not a full composer on one side and a strip on the other.
 *
 * Only the field and what goes next to it (`trailing`); the caller decides the send.
 */
export const CompactInput = forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (value: string) => void
    /** Enter without Shift; returns true when it sent (the field is cleared) */
    onSubmit: (value: string) => boolean | void
    placeholder: string
    disabled?: boolean
    /** Gained/lost focus (the panels window only accepts the keyboard while it is in use) */
    onFocusChange?: (focused: boolean) => void
    trailing?: ReactNode
    className?: string
  }
>(function CompactInput({ value, onChange, onSubmit, placeholder, disabled, onFocusChange, trailing, className }, ref) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onPointerDown={() => onFocusChange?.(true)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          if (onSubmit(value)) onChange("")
        }}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={placeholder}
        className="w-full min-w-0 bg-transparent text-[13.5px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
      />
      {trailing}
    </div>
  )
})
