import { useState } from "react"
import { Brain, Globe, PlusIcon, Search } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
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
import { ModeToggle } from "@/src/components/mode-toggle"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { useProviderStore } from "@/src/stores/provider-store"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import type { SendMessageOptions } from "@/shared/chat"
import type { ChatStatus } from "@/shared/chat"

export function ChatInput({ onSubmit, status, onStop }: {
  onSubmit: (text: string, options: SendMessageOptions) => void
  status?: ChatStatus
  onStop?: () => void
}) {
  const [search, setSearch] = useState(false)
  const [browser, setBrowser] = useState(false)
  const selected = useProviderStore((s) => s.selectedModel)
  const model = useProviderStore((s) =>
    s.selectedModel ? s.catalog[s.selectedModel.providerId]?.models[s.selectedModel.modelId] : undefined,
  )
  const { enabled, variantId, update } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  const thinking = enabled || !!model?.reasoningAlwaysOn
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
          onSubmit(text, {
            research: search,
            browser,
            reasoning: { enabled: thinking, variantId },
          })
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
                <PromptInputActionAddAttachments label="Anexar arquivos" />
              </DropdownMenuContent>
            </DropdownMenu>
            <ModeToggle
              icon={Search}
              label="Pesquisa"
              description="Busca e lê páginas da web via HTTP. Rápido, mas não executa JavaScript."
              active={search}
              onToggle={() => setSearch((v) => !v)}
            />
            <ModeToggle
              icon={Globe}
              label="Browser"
              description="Navega em páginas como um browser real. Executa JavaScript, ideal para SPAs."
              active={browser}
              onToggle={() => setBrowser((v) => !v)}
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
              disabled={!selected && !busy}
              status={busy ? (status === "submitted" ? "submitted" : "streaming") : undefined}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
