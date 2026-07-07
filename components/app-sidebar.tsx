import { Ellipsis, Folder, MessageSquare, Pin, Plus, Terminal, Trash2, User, Archive, Pencil, Settings, LogOut, Sun } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const chatHistory = [
  { id: "1", title: "Implementação de autenticação" },
  { id: "2", title: "Refatorar component Button" },
  { id: "3", title: "API de usuários - revisão" },
  { id: "4", title: "Configurar Docker Compose" },
  { id: "5", title: "Testes unitários do módulo X" },
  { id: "6", title: "Documentação do projeto" },
  { id: "7", title: "Otimização de queries SQL" },
  { id: "8", title: "Pipeline CI/CD" },
]

function NewChatButton() {
  return (
    <Button variant="outline" className="w-full justify-start gap-2 text-sm">
      <Plus className="size-4" />
      Novo Chat
    </Button>
  )
}

function ModeTabs() {
  return (
    <Tabs defaultValue="chat">
      <TabsList className="w-full">
        <TabsTrigger value="chat" className="flex-1 gap-1.5">
          <MessageSquare className="size-3.5" />
          Chat
        </TabsTrigger>
        <TabsTrigger value="code" className="flex-1 gap-1.5">
          <Terminal className="size-3.5" />
          Código
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

function ChatItem({ chat }: { chat: { id: string; title: string } }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton className="text-xs">
        <MessageSquare className="size-4" />
        <span>{chat.title}</span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-slot="sidebar-menu-action"
          data-sidebar="menu-action"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className={cn(
            "absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
            "opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 aria-expanded:opacity-100",
          )}
        >
          <Ellipsis className="size-4" />
          <span className="sr-only">Opções do chat</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="right"
          sideOffset={8}
          className="w-48"
        >
          <DropdownMenuItem>
            <Pin className="size-4" />
            Fixar
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Pencil className="size-4" />
            Renomear
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Folder className="size-4" />
            Adicionar a pasta
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
    </SidebarMenuItem>
  )
}

function ChatHistory() {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {chatHistory.map((chat) => (
            <ChatItem key={chat.id} chat={chat} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function AccountDropdown() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button className="flex w-full items-center gap-2 rounded-md p-2 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />}>
        <Avatar size="sm">
          <AvatarImage src="" />
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <div className="flex flex-1 flex-col truncate">
          <span className="truncate font-medium">João Desenvolvedor</span>
          <span className="truncate text-sidebar-foreground/60">joao@email.com</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-(--radix-popper-anchor-width)"
      >
        <DropdownMenuLabel>Minha Conta</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <User className="size-4" />
            Perfil
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Settings className="size-4" />
            Configurações
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Sun className="size-4" />
            Tema
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <LogOut className="size-4" />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountSection() {
  return (
    <div className="flex items-center p-2">
      <AccountDropdown />
    </div>
  )
}

export function AppSidebar() {
  return (
    <Sidebar variant="floating" collapsible="offcanvas">
      <SidebarHeader>
        <ModeTabs />
      </SidebarHeader>
      <SidebarContent>
        <div className="px-3 py-2">
          <NewChatButton />
        </div>
        <SidebarSeparator />
        <ChatHistory />
      </SidebarContent>
      <SidebarFooter>
        <SidebarSeparator />
        <AccountSection />
      </SidebarFooter>
    </Sidebar>
  )
}
