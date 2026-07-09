import { useState } from "react"
import { Brain, FileText, PlusIcon, Search } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
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
import { ModeToggle } from "@/src/components/mode-toggle"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { FolderSelector } from "@/src/components/folder-selector"
import { useWorkspace } from "@/lib/workspace-context"
import { useProviderStore } from "@/src/stores/provider-store"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
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
  const [search, setSearch] = useState(false)
  const { folders, setFolders } = useWorkspace()
  const selected = useProviderStore((s) => s.selectedModel)
  const model = useProviderStore((s) =>
    s.selectedModel ? s.catalog[s.selectedModel.providerId]?.models[s.selectedModel.modelId] : undefined,
  )
  const { enabled, variantId, update } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  const thinking = enabled || !!model?.reasoningAlwaysOn
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
    onSubmit(
      text,
      { plan, research: search, reasoning: { enabled: thinking, variantId } },
      directory,
      extraDirectories,
    )
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
                  <PromptInputActionAddAttachments label="Anexar arquivos" />
                </DropdownMenuContent>
              </DropdownMenu>
              <ModeToggle
                icon={Search}
                label="Pesquisa"
                description="Libera websearch e webfetch para consultar documentação online."
                active={search}
                onToggle={() => setSearch((v) => !v)}
              />
              <ModeToggle
                icon={FileText}
                label="Modo Plano"
                description="Somente leitura. Produz um plano de implementação sem editar arquivos."
                active={plan}
                onToggle={() => setPlan((v) => !v)}
              />
              {model?.reasoning && (
                <ModeToggle
                  icon={Brain}
                  label="Thinking"
                  description={
                    model.reasoningAlwaysOn
                      ? "Este modelo sempre usa raciocínio extendido."
                      : "Ativa raciocínio extendido do modelo. Custa mais tokens e tempo."
                  }
                  active={thinking}
                  onToggle={() => update({ enabled: !enabled, variantId })}
                  disabled={model.reasoningAlwaysOn}
                />
              )}
            </PromptInputTools>
            <div className="flex items-center gap-1">
              {thinking && model?.variants && model.variants.length > 0 && (
                <ReasoningPicker
                  variants={model.variants}
                  selected={variantId}
                  onSelect={(id) => update({ enabled: true, variantId: id })}
                />
              )}
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
