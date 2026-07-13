import { useEffect, useState, type CSSProperties } from "react"
import {
  ArchiveRestore,
  Copy,
  ExternalLink,
  Eye,
  FileCode,
  FilePlus,
  FolderOpen,
  Info,
  Maximize2,
  Menu as MenuIcon,
  Minus,
  PanelLeft,
  PanelRightOpen,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  Undo2,
  X,
  ClipboardPaste,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { windowApi } from "@/src/lib/ipc"
import { useWorkspace } from "@/lib/workspace-context"

const dragStyle: CSSProperties = { WebkitAppRegion: "drag" } as CSSProperties
const noDragStyle: CSSProperties = { WebkitAppRegion: "no-drag" } as CSSProperties

function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    windowApi.isMaximized().then(setMaximized)
    return windowApi.onMaximizedChange(setMaximized)
  }, [])

  return (
    <div className="flex h-full items-stretch" style={noDragStyle}>
      <button
        type="button"
        aria-label="Minimizar"
        onClick={() => windowApi.minimize()}
        className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restaurar" : "Maximizar"}
        onClick={() => windowApi.maximize()}
        className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {maximized ? <Copy className="size-3" /> : <Maximize2 className="size-3" />}
      </button>
      <button
        type="button"
        aria-label="Fechar"
        onClick={() => windowApi.close()}
        className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function HamburgerMenu() {
  const [open, setOpen] = useState(false)
  const { setView, setMode } = useWorkspace()

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" className="size-6" style={noDragStyle} />}
      >
        <MenuIcon className="size-3.5" />
        <span className="sr-only">Menu</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FilePlus className="size-4" />
            Arquivo
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => setView("chat")}>
              <FilePlus className="size-4" />
              Nova conversa
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setMode("code")}>
              <FileCode className="size-4" />
              Novo código
            </DropdownMenuItem>
            <DropdownMenuItem>
              <FolderOpen className="size-4" />
              Abrir pasta
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => windowApi.close()}>
              <X className="size-4" />
              Sair
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Undo2 className="size-4" />
            Editar
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>
              <Undo2 className="size-4" />
              Desfazer
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Redo2 className="size-4" />
              Refazer
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <Scissors className="size-4" />
              Recortar
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy className="size-4" />
              Copiar
            </DropdownMenuItem>
            <DropdownMenuItem>
              <ClipboardPaste className="size-4" />
              Colar
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Eye className="size-4" />
            Visualizar
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => setView("chat")}>
              <PanelLeft className="size-4" />
              Conversas
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setView("models")}>
              <PanelRightOpen className="size-4" />
              Models
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => windowApi.toggleFullscreen()}>
              <Maximize2 className="size-4" />
              Tela cheia
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => location.reload()}>
              <RefreshCw className="size-4" />
              Recarregar
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Info className="size-4" />
            Ajuda
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>
              <ExternalLink className="size-4" />
              Documentação
            </DropdownMenuItem>
            <DropdownMenuItem>
              <ArchiveRestore className="size-4" />
              Sobre o Orbit
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TitleBar({ onSearchOpen }: { onSearchOpen?: () => void }) {
  const isMac = windowApi.platform === "darwin"

  return (
    <div
      className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border/50 bg-sidebar"
      style={dragStyle}
    >
      <div className="flex h-full items-center gap-1 pl-1.5" style={noDragStyle}>
        <HamburgerMenu />
        <button
          type="button"
          aria-label="Buscar conversas"
          onClick={onSearchOpen}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Search className="size-3.5" />
        </button>
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground">Orbit</span>
      </div>
      <div className="flex h-full items-center pr-1.5" style={noDragStyle}>
        {!isMac && <WindowControls />}
      </div>
    </div>
  )
}
