import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface UserMessageNavItem {
  id: string
  text: string
}

interface UserMessageNavProps {
  items: UserMessageNavItem[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function UserMessageNav({ items, activeId, onSelect }: UserMessageNavProps) {
  if (items.length < 2) return null

  return (
    <nav className="pointer-events-none absolute right-3 top-4 z-30 flex flex-col items-end gap-1.5">
      <TooltipProvider delay={300}>
        {items.map((item) => (
          <Tooltip key={item.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "pointer-events-auto rounded-full transition-all duration-200 ease-out",
                    item.id === activeId
                      ? "h-1.5 w-5 bg-foreground shadow-sm"
                      : "h-1.5 w-2 bg-muted-foreground/40 hover:w-4 hover:bg-muted-foreground/70",
                  )}
                  aria-label={item.text}
                />
              }
            />
            <TooltipContent side="left" align="center" sideOffset={8} className="bg-popover text-popover-foreground">
              <span className="line-clamp-2 max-w-40 text-xs">{item.text}</span>
            </TooltipContent>
          </Tooltip>
        ))}
      </TooltipProvider>
    </nav>
  )
}
