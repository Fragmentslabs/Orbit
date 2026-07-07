import { useCallback, useRef, useState } from "react"
import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"

const HOVER_ZONE_WIDTH = 6
const SIDEBAR_HIDE_DELAY = 300
const SIDEBAR_SHOW_DELAY = 100

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

function Layout() {
  const { open, setOpen } = useSidebar()
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()

  const handleSidebarMouseEnter = useCallback(() => {
    clearTimeout(hideTimer.current)
  }, [])

  const handleSidebarMouseLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => setOpen(false), SIDEBAR_HIDE_DELAY)
  }, [setOpen])

  return (
    <div className="relative flex flex-1">
      {!open && <HoverEdge />}
      <div
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
      >
        <AppSidebar />
      </div>
      <main className="flex flex-1 flex-col p-4">
        <SidebarTrigger />
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
    <TooltipProvider>
      <SidebarProvider open={open} onOpenChange={setOpen}>
        <Layout />
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
