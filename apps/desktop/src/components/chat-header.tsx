import { Archive, Ellipsis, PanelLeft, PanelRightClose, PanelRightOpen, Pencil, Pin, Trash2 } from "lucide-react"
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
  hasMenu?: boolean
  rightPanelOpen?: boolean
  onToggleSidebar?: () => void
  onToggleRightPanel?: () => void
}

export function ChatHeader({ title = "Nova conversa", hasMenu, rightPanelOpen, onToggleSidebar, onToggleRightPanel }: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="flex h-12 items-center gap-2 px-4">
      {onToggleSidebar && (
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={onToggleSidebar}>
          <PanelLeft className="size-4" />
          <span className="sr-only">Alternar sidebar</span>
        </Button>
      )}
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {hasMenu && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="size-6 shrink-0" />}>
              <Ellipsis className="size-3.5" />
              <span className="sr-only">Opções</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuItem>
                <Pin className="size-4" />
                Fixar
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
        )}
      </div>
      {onToggleRightPanel && (
        <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={onToggleRightPanel}>
          {rightPanelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          <span className="sr-only">Alternar painel</span>
        </Button>
      )}
    </div>
  )
}
