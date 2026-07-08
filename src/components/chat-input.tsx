import { useState } from "react"
import { Brain, Globe, PlusIcon, Search } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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
import { ModelPicker } from "@/src/components/model-picker"
import { useProviderStore } from "@/src/stores/provider-store"
import type { SendMessageOptions } from "@/shared/chat"
import type { ChatStatus } from "@/shared/chat"

export function ChatInput({ onSubmit, status, onStop }: {
  onSubmit: (text: string, options: SendMessageOptions) => void
  status?: ChatStatus
  onStop?: () => void
}) {
  const [search, setSearch] = useState(false)
  const [browser, setBrowser] = useState(false)
  const [thinking, setThinking] = useState(false)
  const selected = useProviderStore((s) => s.selectedModel)
  const model = useProviderStore((s) =>
    s.selectedModel ? s.catalog[s.selectedModel.providerId]?.models[s.selectedModel.modelId] : undefined,
  )
  const busy = status === "submitted" || status === "streaming"

  return (
    <div className="w-full max-w-2xl mx-auto pb-4">
      <PromptInput
        multiple
        onSubmit={(message) => {
          if (busy) {
            onStop?.()
            return
          }
          const text = message.text?.trim()
          if (!text) return
          onSubmit(text, { research: search, browser, thinking })
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
                  <TooltipProvider delay={300}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="flex flex-1 items-center gap-2" />
                        }
                      >
                        <Search className="size-4" />
                        Pesquisa
                      </TooltipTrigger>
                      <TooltipContent side="right" align="center" sideOffset={8}>
                        Busca e lê páginas da web via HTTP.
                        Rápido, mas não executa JavaScript.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={browser}
                  onCheckedChange={(checked) => setBrowser(checked)}
                >
                  <TooltipProvider delay={300}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="flex flex-1 items-center gap-2" />
                        }
                      >
                        <Globe className="size-4" />
                        Browser
                      </TooltipTrigger>
                      <TooltipContent side="right" align="center" sideOffset={8}>
                        Navega em páginas como um browser real.
                        Executa JavaScript, ideal para SPAs.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </DropdownMenuCheckboxItem>
                {model?.reasoning && (
                  <DropdownMenuCheckboxItem
                    checked={thinking}
                    onCheckedChange={(checked) => setThinking(checked)}
                  >
                    <Brain className="size-4" />
                    Thinking
                  </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuSeparator />
                <PromptInputActionAddAttachments label="Anexar arquivos" />
              </DropdownMenuContent>
            </DropdownMenu>
          </PromptInputTools>
          <div className="flex items-center gap-1">
            {search && <Search className="size-3 text-sidebar-foreground/40" />}
            {browser && <Globe className="size-3 text-sidebar-foreground/40" />}
            {thinking && <Brain className="size-3 text-sidebar-foreground/40" />}
            <ModelPicker />
            <PromptInputSubmit
              disabled={!selected && !busy}
              status={busy ? (status === "submitted" ? "submitted" : "streaming") : undefined}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
