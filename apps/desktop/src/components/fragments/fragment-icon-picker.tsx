import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { iconNames } from "lucide-react/dynamic"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { fragmentApi } from "@/src/lib/ipc"
import { FragmentIcon } from "./fragment-icon"

/** Icons shown before the person types anything — a friendly starting set. */
const SUGGESTED = [
  "app-window", "chart-bar", "wallet", "list-checks", "notebook-pen", "timer", "calendar", "dumbbell",
  "book-open", "graduation-cap", "music", "mic", "image", "wand-sparkles", "bot", "brain",
  "database", "terminal", "globe", "mail", "message-circle", "heart-pulse", "shopping-cart", "map",
]

/** At most this many tiles are drawn: each one loads its own icon, so a search narrows rather than scrolls. */
const MAX_TILES = 120

/** The modal that changes a fragment's icon: every lucide icon, searchable by name. */
export function FragmentIconPicker({
  open,
  onOpenChange,
  fragmentId,
  current,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fragmentId: string
  current: string
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState("")

  const tiles = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "-")
    if (!q) return SUGGESTED.filter((name) => (iconNames as string[]).includes(name))
    return (iconNames as string[]).filter((name) => name.includes(q)).slice(0, MAX_TILES)
  }, [query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("fragments.iconTitle")}</DialogTitle>
          <DialogDescription>{t("fragments.iconHint")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("fragments.iconSearch")}
          aria-label={t("fragments.iconSearch")}
        />
        <div className="grid max-h-72 grid-cols-6 gap-1.5 overflow-y-auto sm:grid-cols-8">
          {tiles.map((name) => (
            <button
              key={name}
              type="button"
              title={name}
              aria-label={name}
              aria-pressed={name === current}
              onClick={() => {
                void fragmentApi.update(fragmentId, { icon: name })
                onOpenChange(false)
              }}
              className={cn(
                "flex aspect-square items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                name === current && "border-primary bg-primary/10 text-primary",
              )}
            >
              <FragmentIcon name={name} className="size-5" />
            </button>
          ))}
          {tiles.length === 0 && (
            <p className="col-span-full py-6 text-center text-xs text-muted-foreground">{t("fragments.iconNone")}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
