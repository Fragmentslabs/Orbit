import { Archive, Ellipsis, PanelRightClose, PanelRightOpen, Pencil, Pin, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

interface ChatHeaderProps {
  title?: string
  pinned?: boolean
  rightPanelOpen?: boolean
  onToggleRightPanel?: () => void
}

export function ChatHeader({ title = "Nova conversa", pinned, rightPanelOpen, onToggleRightPanel }: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="flex h-12 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
      </div>
      <div className="flex items-center gap-1">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-7" />}>
            <Ellipsis className="size-4" />
            <span className="sr-only">Opções</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem>
              <Pin className="size-4" />
              {pinned ? "Desafixar" : "Fixar"}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Pencil className="size-4" />
              Renomear
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Archive className="size-4" />
              Arquivar
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Trash2 className="size-4" />
              Deletar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onToggleRightPanel && (
          <Button variant="ghost" size="icon-sm" className="size-7" onClick={onToggleRightPanel}>
            {rightPanelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            <span className="sr-only">Alternar painel</span>
          </Button>
        )}
      </div>
    </div>
  )
}
