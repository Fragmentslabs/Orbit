import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"

/**
 * Right-click menu of the Design tab. Opens at a screen position (the pointer on the
 * Layers list, or the pointer on the canvas — which the bridge reports through an
 * iframe), so it does not hang from a trigger element like the DropdownMenu. Same
 * look as the app's menus.
 */

export type DesignMenuItem =
  | { separator: true }
  | {
      label: string
      icon?: ComponentType<{ className?: string }>
      /** Text of the shortcut, already formatted for the platform (e.g. "⌘G"). */
      shortcut?: string
      disabled?: boolean
      destructive?: boolean
      onSelect: () => void
    }

interface Props {
  x: number
  y: number
  items: DesignMenuItem[]
  onClose: () => void
}

export function DesignContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keeps the menu inside the window (it flips up/left when it would overflow).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    })
  }, [x, y, items])

  useEffect(() => {
    const away = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("pointerdown", away, true)
    window.addEventListener("contextmenu", away, true)
    window.addEventListener("keydown", key, true)
    window.addEventListener("blur", onClose)
    window.addEventListener("resize", onClose)
    window.addEventListener("wheel", onClose, { passive: true, capture: true })
    return () => {
      window.removeEventListener("pointerdown", away, true)
      window.removeEventListener("contextmenu", away, true)
      window.removeEventListener("keydown", key, true)
      window.removeEventListener("blur", onClose)
      window.removeEventListener("resize", onClose)
      window.removeEventListener("wheel", onClose, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[999] min-w-52 rounded-lg bg-popover/80 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150 animate-in fade-in-0 zoom-in-95 duration-100"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) =>
        "separator" in item ? (
          <div key={`sep-${index}`} role="separator" className="-mx-1 my-1 h-px bg-foreground/5" />
        ) : (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
            className={cn(
              "flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-left text-xs/relaxed outline-hidden select-none hover:bg-foreground/10 focus-visible:bg-foreground/10 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
              item.destructive && "text-destructive",
            )}
          >
            {item.icon ? <item.icon /> : <span className="size-3.5 shrink-0" />}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="ml-4 text-[0.625rem] tracking-widest text-muted-foreground">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
