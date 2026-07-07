import { useCallback, useEffect, useRef, useState } from "react"
import { Brain, Globe, PanelLeftIcon, PlusIcon, Search } from "lucide-react"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import { ThemeProvider } from "@/components/theme-provider"
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace-context"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/src/components/ai/prompt-input"

const HOVER_ZONE_WIDTH = 6
const SIDEBAR_HIDE_DELAY = 300
const SIDEBAR_SHOW_DELAY = 100
const STORAGE_KEY = "sidebar-mode"

type SidebarMode = "hover" | "pinned"

function loadMode(): SidebarMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === "hover" || stored === "pinned") return stored
  return "hover"
}

function HoverEdge() {
  const { setOpen } = useSidebar()
  const showTimer = useRef<ReturnType<typeof setTimeout>>()

  const handleMouseEnter = useCallback(() => {
    clearTimeout(showTimer.current)
    showTimer.current = setTimeout(() => setOpen(true), SIDEBAR_SHOW_DELAY)
  }, [setOpen])

  return (
    <div
      className="absolute left-0 top-0 z-50 h-full"
      style={{ width: HOVER_ZONE_WIDTH }}
      onMouseEnter={handleMouseEnter}
    />
  )
}

function SidebarToggle({ onToggle }: { onToggle: () => void }) {
  const handleClick = useCallback(() => {
    onToggle()
  }, [onToggle])

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      onClick={handleClick}
    >
      <PanelLeftIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

function Placeholder() {
  const { mode } = useWorkspace()

  if (mode === "chat") {
    return <p>Selecione um chat ou inicie uma nova conversa</p>
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <p>Selecione um contexto de código</p>
      <p className="text-xs text-muted-foreground">Gere, refatore ou analise código</p>
    </div>
  )
}

function ChatInput() {
  const [search, setSearch] = useState(false)
  const [browser, setBrowser] = useState(false)
  const [memory, setMemory] = useState(false)

  return (
    <div className="w-full max-w-2xl mx-auto pb-4 rounded-xl border-2 border-sidebar-border overflow-hidden">
      <PromptInput
        multiple
        onSubmit={(message) => {
          console.log("Chat message:", message)
        }}
        className="[&>div]:!border-none [&>div]:!rounded-none"
      >
        <PromptInputAttachments>
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Pergunte qualquer coisa..." className="px-3 text-sm" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <DropdownMenu>
              <DropdownMenuTrigger render={<PromptInputButton><PlusIcon className="size-4" /></PromptInputButton>} />
              <DropdownMenuContent align="start" className="min-w-40">
                <DropdownMenuCheckboxItem
                  checked={search}
                  onCheckedChange={(checked) => setSearch(checked)}
                >
                  <Search className="size-4" />
                  Pesquisa
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={browser}
                  onCheckedChange={(checked) => setBrowser(checked)}
                >
                  <Globe className="size-4" />
                  Browser
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={memory}
                  onCheckedChange={(checked) => setMemory(checked)}
                >
                  <Brain className="size-4" />
                  Memória
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <PromptInputActionAddAttachments label="Anexar arquivos" />
              </DropdownMenuContent>
            </DropdownMenu>
          </PromptInputTools>
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}

function Layout() {
  const { open, setOpen } = useSidebar()
  const { mode: workspaceMode } = useWorkspace()
  const [mode, setMode] = useState<SidebarMode>(loadMode)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  useEffect(() => {
    if (mode === "pinned") {
      setOpen(true)
    }
  }, [mode, setOpen])

  const handleSidebarMouseEnter = useCallback(() => {
    clearTimeout(hideTimer.current)
  }, [])

  const handleSidebarMouseLeave = useCallback(() => {
    if (mode === "hover") {
      hideTimer.current = setTimeout(() => setOpen(false), SIDEBAR_HIDE_DELAY)
    }
  }, [mode, setOpen])

  const handleToggle = useCallback(() => {
    if (open) {
      setMode("hover")
      setOpen(false)
    } else {
      setMode("pinned")
      setOpen(true)
    }
  }, [open, setOpen])

  return (
    <div className="relative flex flex-1">
      {!open && mode === "hover" && <HoverEdge />}
      <div
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
      >
        <AppSidebar />
      </div>
      <main className="flex flex-1 flex-col p-4">
        <SidebarToggle onToggle={handleToggle} />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Placeholder />
        </div>
        {workspaceMode === "chat" && <ChatInput />}
      </main>
    </div>
  )
}

function App() {
  const [open, setOpen] = useState(false)

  return (
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <TooltipProvider>
        <WorkspaceProvider>
          <SidebarProvider open={open} onOpenChange={setOpen}>
            <Layout />
          </SidebarProvider>
        </WorkspaceProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App
