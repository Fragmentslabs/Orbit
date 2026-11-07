import { useTranslation } from "react-i18next"
import { PinIcon, PinOffIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"

/** The pin glyph and tooltip every fullscreen dock shares; the caller supplies the box around it. */
function PinToggle({ pinned, onToggle, className }: { pinned: boolean; onToggle: () => void; className: string }) {
  const { t } = useTranslation()
  return (
    <Hint label={pinned ? t("browser.unpinFeed") : t("browser.pinFeed")}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
          pinned && "text-primary hover:text-primary",
          className,
        )}
      >
        {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
      </button>
    </Hint>
  )
}

/** Pin of the side feeds: it pins the panel open (the hover only opens while the mouse is on it). */
export function FeedPinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return <PinToggle pinned={pinned} onToggle={onToggle} className="size-6 shrink-0" />
}

/** Grab handle on the top of a bottom composer: the part that stays visible when it is collapsed, with its pin. */
export function DockHandle({ pinned, onTogglePin }: { pinned: boolean; onTogglePin: () => void }) {
  return (
    <div className="relative flex h-7 items-center justify-center">
      <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
      <PinToggle pinned={pinned} onToggle={onTogglePin} className="absolute right-2 top-1/2 size-5 -translate-y-1/2" />
    </div>
  )
}
