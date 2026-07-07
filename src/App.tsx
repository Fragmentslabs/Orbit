import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"

function App() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <main className="flex flex-1 flex-col p-4">
          <SidebarTrigger />
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <p>Selecione um chat ou inicie uma nova conversa</p>
          </div>
        </main>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
