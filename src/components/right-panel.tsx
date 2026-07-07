import { Globe, Folder, MessagesSquare, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"

const items = [
  { icon: MessagesSquare, label: "Chat" },
  { icon: Terminal, label: "Terminal" },
  { icon: Folder, label: "Pastas" },
  { icon: Globe, label: "Browser" },
]

export function RightPanel() {
  return (
    <div className="flex h-full flex-col rounded-lg shadow-sm ring-1 ring-sidebar-border bg-sidebar">
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-medium text-foreground">Painel</span>
      </div>
      <div className="flex flex-col gap-1 p-2">
        {items.map(({ icon: Icon, label }) => (
          <Button key={label} variant="ghost" className="w-full justify-start gap-2 px-2 text-xs">
            <Icon className="size-4" />
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}
