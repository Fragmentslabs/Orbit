import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, X, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * The card a conversation leaves for a piece it made (motion, design, fragment…): the way
 * back to it once its panel tab was closed. Only the look and the open/gone behavior live
 * here, the same for every kind; what a card opens, and how, is each kind's business.
 *
 * `onOpen` answers whether the piece could be opened: false shows the "gone" notice.
 */
export function PieceCard({
  icon: Icon,
  label,
  subtitle,
  openTitle,
  goneText,
  canOpen,
  onOpen,
}: {
  icon: LucideIcon
  label: string
  subtitle?: string
  /** Tooltip while the card is clickable. */
  openTitle: string
  /** What to say when the piece no longer exists. */
  goneText: string
  canOpen: boolean
  onOpen: () => Promise<boolean> | boolean
}) {
  const { t } = useTranslation()
  const [opening, setOpening] = useState(false)
  const [gone, setGone] = useState(false)

  const open = useCallback(() => {
    if (!canOpen || opening) return
    setOpening(true)
    setGone(false)
    Promise.resolve(onOpen())
      .then((ok) => setGone(!ok))
      .catch(() => setGone(true))
      .finally(() => setOpening(false))
  }, [canOpen, opening, onOpen])

  return (
    <div className="not-prose my-2 w-full max-w-md">
      <div
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            open()
          }
        }}
        title={canOpen ? openTitle : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors",
          canOpen && "cursor-pointer hover:bg-accent/50",
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <Truncate text={label}>
            <p className="truncate text-sm font-medium text-foreground">{label}</p>
          </Truncate>
          {subtitle && (
            <Truncate>
              <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
            </Truncate>
          )}
        </div>
        {opening && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {gone && (
        <div className="mt-1 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <p className="min-w-0 flex-1">{goneText}</p>
          <button
            type="button"
            onClick={() => setGone(false)}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-destructive/20"
            aria-label={t("common.close")}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
