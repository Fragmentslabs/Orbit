import { useState } from "react"
import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
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
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/src/components/ai/model-selector"
import { FolderSelector } from "@/src/components/folder-selector"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function loadLastFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {}
  return []
}

function saveRecentFolders(folders: string[]) {
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
}

const models = [
  { id: "gpt-4o", name: "GPT-4o", chef: "OpenAI", chefSlug: "openai", providers: ["openai", "azure"] },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", chef: "OpenAI", chefSlug: "openai", providers: ["openai"] },
  { id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet", chef: "Anthropic", chefSlug: "anthropic", providers: ["anthropic"] },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", chef: "Google", chefSlug: "google", providers: ["google"] },
]

export function CodeInput() {
  const [modelOpen, setModelOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState("gpt-4o")
  const [folders, setFolders] = useState<string[]>(loadLastFolders)
  const [submitted, setSubmitted] = useState(false)
  const selectedModelData = models.find(m => m.id === selectedModel)
  const chefs = Array.from(new Set(models.map(m => m.chef)))

  const handleSubmit = (message: unknown) => {
    if (!submitted && folders.length > 0) {
      saveRecentFolders(folders)
    }
    setSubmitted(true)
    console.log("Code message:", message)
  }

  const isNewChat = !submitted

  return (
    <div className="w-full max-w-2xl mx-auto pb-4">
      <PromptInput
        multiple
        onSubmit={handleSubmit}
        className="rounded-xl border-2 border-sidebar-border overflow-hidden [&>div]:!border-none [&>div]:!rounded-none [&>div]:!bg-transparent"
      >
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 w-full empty:hidden">
          {(isNewChat || folders.length > 0) && (
            <FolderSelector folders={folders} onFoldersChange={setFolders} />
          )}
          <PromptInputAttachments className="!p-0 !m-0 !gap-2">
            {(attachment) => <PromptInputAttachment data={attachment} />}
          </PromptInputAttachments>
        </div>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Pergunte sobre código..." className="px-3 text-base md:text-base" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <DropdownMenu>
              <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                <PlusIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-40">
                <PromptInputActionAddAttachments label="Anexar arquivos" />
              </DropdownMenuContent>
            </DropdownMenu>
          </PromptInputTools>
          <div className="flex items-center gap-1">
            <ModelSelector onOpenChange={setModelOpen} open={modelOpen}>
              <ModelSelectorTrigger render={<Button className="h-7 gap-1 px-1.5 text-xs" variant="ghost" />}>
                <ModelSelectorLogo provider={selectedModelData?.chefSlug ?? "openai"} />
                <ModelSelectorName>{selectedModelData?.name ?? "GPT-4o"}</ModelSelectorName>
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </ModelSelectorTrigger>
              <ModelSelectorContent>
                <ModelSelectorInput placeholder="Search models..." />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  {chefs.map(chef => (
                    <ModelSelectorGroup heading={chef} key={chef}>
                      {models.filter(m => m.chef === chef).map(model => (
                        <ModelSelectorItem
                          key={model.id}
                          onSelect={() => { setSelectedModel(model.id); setModelOpen(false) }}
                          value={model.id}
                        >
                          <ModelSelectorLogo provider={model.chefSlug} />
                          <ModelSelectorName>{model.name}</ModelSelectorName>
                          <ModelSelectorLogoGroup>
                            {model.providers.map(p => (
                              <ModelSelectorLogo key={p} provider={p} />
                            ))}
                          </ModelSelectorLogoGroup>
                          {selectedModel === model.id
                            ? <CheckIcon className="ml-auto size-4" />
                            : <div className="ml-auto size-4" />}
                        </ModelSelectorItem>
                      ))}
                    </ModelSelectorGroup>
                  ))}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>
            <PromptInputSubmit />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
