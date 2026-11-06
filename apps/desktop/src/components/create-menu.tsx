import { ChevronDown, PlusIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface CreateMenuOption {
  id: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  onSelect: () => void
}

/**
 * The "create" button of the Tools sections (MCP, Skills, Hooks): one button that
 * opens the ways to make one — asking Orbit first, then by hand, then the extras of
 * the section (importing a skill). The same shape in the three sections.
 */
export function CreateMenu({ label, options }: { label: string; options: CreateMenuOption[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90">
        <PlusIcon className="size-3.5" />
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 p-1.5">
        {options.map(({ id, icon: Icon, title, description, onSelect }) => (
          <DropdownMenuItem key={id} onClick={onSelect}>
            <Icon className="size-3.5" />
            <div className="flex flex-col">
              <span>{title}</span>
              <span className="text-xs text-muted-foreground">{description}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
