import { cn } from "@/lib/utils"

export interface StatBadge {
  label: string
  value: string
  /** "bad" paints it red (a failure); the rest is neutral. */
  tone?: "bad"
  /** The detail that does not fit the badge. */
  title?: string
}

/**
 * The numbers of a page as small badges in a fixed footer (Routines, Pipeline): always in sight,
 * whatever the width. `separated` draws a line under them, for when something comes right after.
 */
export function StatBadges({ items, separated }: { items: StatBadge[]; separated?: boolean }) {
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-1.5", separated && "border-b pb-2.5")}>
      {items.map((item) => (
        <span
          key={item.label}
          title={item.title}
          className={cn(
            "inline-flex items-baseline gap-1.5 rounded-md px-2 py-1 text-[11px]",
            item.tone === "bad" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
          )}
        >
          {item.label}
          <span className={cn("font-semibold tabular-nums", item.tone !== "bad" && "text-foreground")}>{item.value}</span>
        </span>
      ))}
    </div>
  )
}
