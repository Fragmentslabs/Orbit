import { useState } from "react"
import { Brain, Globe, PlusIcon, Search } from "lucide-react"
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
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/src/components/ai/prompt-input"

export function ChatInput() {
  const [search, setSearch] = useState(false)
  const [browser, setBrowser] = useState(false)
  const [memory, setMemory] = useState(false)

  return (
    <div className="w-full max-w-2xl mx-auto pb-4">
      <PromptInput
        multiple
        onSubmit={(message) => {
          console.log("Chat message:", message)
        }}
        className="rounded-xl border-2 border-sidebar-border overflow-hidden [&>div]:!border-none [&>div]:!rounded-none [&>div]:!bg-transparent"
      >
        <PromptInputAttachments className="!px-3 !py-1.5">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Pergunte qualquer coisa..." className="px-3 text-base md:text-base" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <DropdownMenu>
              <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                <PlusIcon className="size-4" />
              </DropdownMenuTrigger>
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
            {search && <Search className="size-3 text-sidebar-foreground/40" />}
            {browser && <Globe className="size-3 text-sidebar-foreground/40" />}
            {memory && <Brain className="size-3 text-sidebar-foreground/40" />}
          </PromptInputTools>
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
