import { useCallback, useEffect, useRef, useState } from "react"
import { PanelLeftIcon } from "lucide-react"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import { ThemeProvider } from "@/components/theme-provider"

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

function Layout() {
  const { open, setOpen } = useSidebar()
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
    setMode(open ? "hover" : "pinned")
  }, [open])

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
          <p>Selecione um chat ou inicie uma nova conversa</p>
        </div>
      </main>
    </div>
  )
}

function App() {
  const [open, setOpen] = useState(false)

  return (
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <TooltipProvider>
        <SidebarProvider open={open} onOpenChange={setOpen}>
          <Layout />
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App
