import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Truncate } from "@/components/ui/truncated-text"
import { cn } from "@/lib/utils"

/**
 * The header every side-panel tab shares: the type's icon, the title, a small tag with context
 * (a file, a PID, a status) and, on the right, the tab's actions as icon-only buttons with a
 * tooltip. A fixed height and the same border keep the tabs from jumping when the person
 * switches between them.
 *
 * The actions are the tab's own (`children`): they should be icon buttons with a tooltip and an
 * `aria-label` (see IconAction), grouped with `<TabHeaderSeparator />` between unrelated groups.
 */
export function TabHeader({
  icon: Icon,
  iconClassName,
  title,
  tag,
  children,
  className,
}: {
  icon: LucideIcon
  /** Color of the icon — it says what kind of tab this is. */
  iconClassName?: string
  title: string
  /** Short context after the title; a string is drawn as a pill, a node is used as it is. */
  tag?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex h-[42px] shrink-0 items-center gap-2 border-b border-border/60 pr-2 pl-3", className)}>
      <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", iconClassName)} />
      <Truncate text={title}>
        <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{title}</span>
      </Truncate>
      {typeof tag === "string" ? (
        <span className="max-w-44 shrink-0 truncate rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{tag}</span>
      ) : (
        tag
      )}
      {children && <div className="ml-auto flex shrink-0 items-center gap-0.5">{children}</div>}
    </div>
  )
}

/** The thin line between two groups of header actions. */
export function TabHeaderSeparator() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
}
