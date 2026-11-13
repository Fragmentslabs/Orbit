import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { formatTime } from "@/src/lib/format"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface UserMessageNavItem {
  id: string
  text: string
  /** Timestamp (epoch ms) of the message — shown in the tooltip footer */
  time: number
}

interface UserMessageNavProps {
  items: UserMessageNavItem[]
  activeId: string | null
  onSelect: (id: string) => void
  /** IDs of user messages that generated a plan — they get a highlight in the primary color */
  planIds?: Set<string>
}

export function UserMessageNav({ items, activeId, onSelect, planIds }: UserMessageNavProps) {
  const { i18n } = useTranslation()
  if (items.length < 2) return null

  return (
    <nav className="group pointer-events-auto absolute left-3 top-4 z-30 flex flex-col items-start gap-1.5">
      <TooltipProvider delay={300}>
        {items.map((item) => {
          const isPlan = planIds?.has(item.id)
          const isActive = item.id === activeId
          const formattedTime = formatTime(item.time, i18n.language)
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className={cn(
                      // Smooth transition; on the hover of the container (nav) ALL the bars grow (height + width).
                      // The hover stays on the whole group, not on the little bar, so the gaps between the bars do not break the effect.
                      "pointer-events-auto rounded-full transition-all duration-200 ease-out",
                      "group-hover:h-2 group-hover:w-7 group-hover:transition-all group-hover:duration-200",
                      isPlan
                        ? isActive
                          ? "h-1.5 w-5 bg-primary shadow-sm shadow-primary/40 group-hover:w-8 group-hover:bg-primary group-hover:shadow-md group-hover:shadow-primary/40"
                          : "h-1.5 w-2 bg-primary/60 group-hover:bg-primary/80"
                        : isActive
                          ? "h-1.5 w-5 bg-foreground shadow-sm group-hover:w-8 group-hover:bg-foreground group-hover:shadow-md"
                          : "h-1.5 w-2 bg-muted-foreground/40 group-hover:bg-muted-foreground/70",
                    )}
                    aria-label={item.text}
                  />
                }
              />
              <TooltipContent side="right" align="center" sideOffset={8} className="bg-popover text-popover-foreground">
                <span className="line-clamp-2 max-w-40 text-xs">{item.text}</span>
                <span className="mt-1 block text-[10px] tabular-nums text-muted-foreground/70">
                  {formattedTime}
                </span>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </TooltipProvider>
    </nav>
  )
}
