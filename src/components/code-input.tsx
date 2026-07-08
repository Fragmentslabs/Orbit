import { useState } from "react"
import { Brain, FileText, PlusIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  PromptInput,
  PromptInputProvider,
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
import { FolderSelector } from "@/src/components/folder-selector"
import { useWorkspace } from "@/lib/workspace-context"
import { useProviderStore } from "@/src/stores/provider-store"
import type { ChatStatus, SendMessageOptions } from "@/shared/chat"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function saveRecentFolders(folders: string[]) {
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
}

export function CodeInput({ onSubmit, status, onStop, hasMessages }: {
  onSubmit: (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[]) => void
  status?: ChatStatus
  onStop?: () => void
  hasMessages?: boolean
}) {
  const [plan, setPlan] = useState(false)
  const [thinking, setThinking] = useState(false)
  const { folders, setFolders } = useWorkspace()
  const selected = useProviderStore((s) => s.selectedModel)
  const model = useProviderStore((s) =>
    s.selectedModel ? s.catalog[s.selectedModel.providerId]?.models[s.selectedModel.modelId] : undefined,
  )
  const busy = status === "submitted" || status === "streaming"

  const handleSubmit = (message: { text?: string }) => {
    if (busy) {
      onStop?.()
      return
    }
    const text = message.text?.trim()
    if (!text || folders.length === 0) return
    saveRecentFolders(folders)
    const [directory, ...extraDirectories] = folders
    onSubmit(text, { plan, thinking }, directory, extraDirectories)
  }

  return (
    <PromptInputProvider>
      <div className="w-full max-w-2xl mx-auto pb-4">
        {(!hasMessages || folders.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
            <FolderSelector folders={folders} onFoldersChange={setFolders} />
            <PromptInputAttachments className="!p-0 !m-0 !w-auto">
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
          </div>
        )}
        <PromptInput
          multiple
          onSubmit={handleSubmit}
          className="rounded-xl border-2 border-sidebar-border overflow-hidden [&>div]:!border-none [&>div]:!rounded-none [&>div]:!bg-transparent"
        >
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={folders.length === 0 ? "Selecione uma pasta para começar…" : "Pergunte sobre código..."}
              className="px-3 text-base md:text-base"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <DropdownMenu>
                <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                  <PlusIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-40">
                  <DropdownMenuCheckboxItem
                    checked={plan}
                    onCheckedChange={(checked) => setPlan(checked)}
                  >
                    <FileText className="size-4" />
                    Modo Plano
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
              {plan && <FileText className="size-3 text-sidebar-foreground/40" />}
              {thinking && <Brain className="size-3 text-sidebar-foreground/40" />}
              <ModelPicker />
              <PromptInputSubmit
                disabled={(!selected || folders.length === 0) && !busy}
                status={busy ? (status === "submitted" ? "submitted" : "streaming") : undefined}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </PromptInputProvider>
  )
}
