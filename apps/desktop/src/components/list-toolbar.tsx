import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CreateMenu, type CreateMenuOption } from "@/src/components/create-menu"

/**
 * The top row of the list pages (Routines, Pipeline, ...): a search field that takes the
 * width and the page's main action on the right. The title and the filters live in the
 * page header, so the body starts straight in the content.
 */
export function ListToolbar({ query, onQueryChange, placeholder, actionLabel, actionIcon: ActionIcon, onAction, actionOptions, children }: {
  query: string
  onQueryChange: (query: string) => void
  placeholder: string
  actionLabel: string
  actionIcon?: React.ComponentType<{ className?: string }>
  onAction: () => void
  /** More than one way to create: the action becomes a menu with these, and `onAction` is unused. */
  actionOptions?: CreateMenuOption[]
  /** Extra controls between the search and the action (filters). */
  children?: React.ReactNode
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
      <div className="relative min-w-48 flex-1">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-8 pl-8 text-xs"
        />
      </div>
      {children}
      {actionOptions ? (
        <CreateMenu label={actionLabel} options={actionOptions} />
      ) : (
        <Button size="sm" className="h-8 shrink-0 gap-1 px-3 text-xs" onClick={onAction}>
          {ActionIcon && <ActionIcon className="size-3.5" />}
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
