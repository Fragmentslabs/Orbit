import { useState } from "react"
import { AlignLeft, Bot, Brain, BrainCircuit, Globe, Network, PlusIcon, Search } from "lucide-react"
import {
  DropdownMenu,
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
import { DelegationMenuItems } from "@/src/components/delegation-menu"
import { ModelPicker } from "@/src/components/model-picker"
import { ModeToggle } from "@/src/components/mode-toggle"
import { OrchestrationConfigDialog } from "@/src/components/orchestration-config-dialog"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { useBrainEnabled, useBrainPrefs } from "@/src/stores/brain-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import { useSimpleMode } from "@/src/stores/simple-mode"
import type { SendMessageOptions } from "@/shared/chat"
import type { ChatStatus } from "@/shared/chat"

export function ChatInput({ onSubmit, status, onStop, sessionId }: {
  onSubmit: (text: string, options: SendMessageOptions) => void
  status?: ChatStatus
  onStop?: () => void
  /** Sessão ativa — o toggle Brain é por chat (undefined = chat novo) */
  sessionId?: string
}) {
  const [search, setSearch] = useState(false)
  const [browser, setBrowser] = useState(false)
  const [subagents, setSubagents] = useState(false)
  const [orchestra, setOrchestra] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const simple = useSimpleMode((s) => s.simple)
  const setSimple = useSimpleMode((s) => s.setSimple)
  const brain = useBrainEnabled(sessionId)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)
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
            simple,
            brain,
            reasoning: { enabled: thinking, variantId },
            subagents,
            orchestrate: orchestra ? {} : undefined,
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
              <DropdownMenuContent align="start" className="min-w-48">
                <DelegationMenuItems
                  subagents={subagents}
                  orchestra={orchestra}
                  onSubagentsChange={setSubagents}
                  onOrchestraChange={setOrchestra}
                  onOpenConfig={() => setConfigOpen(true)}
                />
                <DropdownMenuSeparator />
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
            <ModeToggle
              icon={AlignLeft}
              label="Simples"
              description="Respostas diretas em texto puro: sem formatação, citações ou blocos de ferramentas."
              active={simple}
              onToggle={() => setSimple(!simple)}
            />
            <ModeToggle
              icon={BrainCircuit}
              label="Memória"
              description="Memória persistente entre conversas: o Orbit lembra fatos e preferências. Desative apenas neste chat."
              active={brain}
              onToggle={() => setBrainEnabled(sessionId, !brain)}
            />
          </PromptInputTools>
          <div className="flex items-center gap-1">
            {subagents && <Bot className="size-3 text-sidebar-foreground/40" />}
            {orchestra && <Network className="size-3 text-sidebar-foreground/40" />}
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
      <OrchestrationConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
    </div>
  )
}
