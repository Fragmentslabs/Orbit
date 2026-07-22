import { useCallback, useMemo, useState } from "react"
import { AlignLeft, Bot, Brain, BrainCircuit, Globe, Network, PlusIcon, Search } from "lucide-react"
import {
  DropdownMenu,
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
  PromptInputTextarea,
  PromptInputTools,
} from "@/src/components/ai/prompt-input"
import { DelegationMenuItems } from "@/src/components/delegation-menu"
import { ModeMenuItems, type ModeToggleDef } from "@/src/components/mode-menu-items"
import { ModelPicker } from "@/src/components/model-picker"
import { ModeToggle } from "@/src/components/mode-toggle"
import { OrchestrationConfigDialog } from "@/src/components/orchestration-config-dialog"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { DraftInputBridge } from "@/src/components/draft-input-bridge"
import { QueueIndicator } from "@/src/components/queue-indicator"
import { ContextMeter } from "@/src/components/context-meter"
import { SendButtonGroup } from "@/src/components/send-button-group"
import { SlashPalette } from "@/src/components/slash-palette"
import { useReferenceCommands, useSlashActionCommands, type SlashCommand } from "@/src/lib/slash-commands"
import { useWorkspace } from "@/lib/workspace-context"
import { useBrainEnabled, useBrainPrefs, useChatContext } from "@/src/stores/brain-prefs"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useProviderStore } from "@/src/stores/provider-store"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import { useSimpleMode, useSimplePrefs } from "@/src/stores/simple-prefs"
import type { ChatStatus, FilePart, SendMessageOptions } from "@shared/chat"
import { toFileParts } from "@/src/lib/message-utils"
import { resolveSlashAction } from "@/src/lib/slash-actions"
import { useAppearanceStore } from "@/src/stores/appearance-store"

export function ChatInput({ onSubmit, status, onStop, sessionId }: {
  onSubmit: (text: string, options: SendMessageOptions, files?: FilePart[]) => void
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
  const simple = useSimpleMode(sessionId)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const brain = useBrainEnabled(sessionId)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)
  const brainContext = useChatContext()
  const selected = useProviderStore((s) => s.selectedModel)
  const model = useProviderStore((s) =>
    s.selectedModel ? s.catalog[s.selectedModel.providerId]?.models[s.selectedModel.modelId] : undefined,
  )
  const { enabled, variantId, update } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  const thinking = enabled || !!model?.reasoningAlwaysOn
  const busy = status === "submitted" || status === "streaming"

  const { mode } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const createSession = useSessionStore((s) => s.createSession)
  const openChatTab = usePanelStore((s) => s.openChatTab)
  const displayMode = useAppearanceStore((s) => s.displayMode)
  const referenceCommands = useReferenceCommands("chat")
  const actionCommands = useSlashActionCommands("chat")

  const modeToggleItems = useMemo<ModeToggleDef[]>(() => [
    { icon: Search, label: "Pesquisa", active: search, onChange: (v: boolean) => setSearch(v) },
    { icon: Globe, label: "Browser", active: browser, onChange: (v: boolean) => setBrowser(v) },
    ...(model?.reasoning ? [{ icon: Brain, label: "Thinking", active: thinking, onChange: (v: boolean) => update({ enabled: v, variantId }) }] : []),
    { icon: AlignLeft, label: "Simples", active: simple, onChange: (v: boolean) => setSimple(sessionId, v) },
    { icon: BrainCircuit, label: "Memória", active: brain, onChange: (v: boolean) => setBrainEnabled(sessionId, v) },
  ], [search, browser, model?.reasoning, thinking, simple, brain, sessionId, variantId, update, setBrainEnabled, setSimple])

  const buildOptions = useCallback((): SendMessageOptions => ({
    research: search,
    browser,
    simple,
    brain,
    brainContext: brainContext === "all" ? true : brainContext === "memory" ? brain : false,
    reasoning: { enabled: thinking, variantId },
    subagents,
    orchestrate: orchestra ? {} : undefined,
  }), [search, browser, simple, brain, brainContext, thinking, variantId, subagents, orchestra])

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText("")
    }
    return [
      { id: "pesquisa", label: "Pesquisa", description: "Alterna busca web (websearch/webfetch)", keywords: ["web", "search"], group: "Modos" as const, active: search, run: toggle(() => setSearch((v) => !v)) },
      { id: "browser", label: "Browser", description: "Alterna navegação com JavaScript", keywords: ["navegador", "web"], group: "Modos" as const, active: browser, run: toggle(() => setBrowser((v) => !v)) },
      ...(model?.reasoning && !model.reasoningAlwaysOn
        ? [{ id: "thinking", label: "Thinking", description: "Alterna raciocínio estendido do modelo", keywords: ["reasoning", "pensar"], group: "Modos" as const, active: thinking, run: toggle(() => update({ enabled: !enabled, variantId })) }]
        : []),
      { id: "simples", label: "Simples", description: "Alterna respostas em texto puro", keywords: ["texto", "plain"], group: "Modos" as const, active: simple, run: toggle(() => setSimple(sessionId, !simple)) },
      { id: "brain", label: "Memória (Brain)", description: "Orbit lembra fatos e preferências entre conversas", keywords: ["memoria", "brain"], group: "Modos" as const, active: brain, run: toggle(() => setBrainEnabled(sessionId, !brain)) },
      { id: "subagents", label: "Subagents", description: "Alterna workers em background", keywords: ["worker", "delegar"], group: "Modos" as const, active: subagents, run: toggle(() => setSubagents((v) => !v)) },
      { id: "orchestra", label: "Orchestra", description: "Alterna orquestração em tarefas paralelas", keywords: ["workers", "plano"], group: "Modos" as const, active: orchestra, run: toggle(() => setOrchestra((v) => !v)) },
      ...actionCommands,
      ...referenceCommands,
      { id: "novo-chat", label: "Nova conversa", description: "Começa um chat em branco", keywords: ["clear", "limpar", "novo"], group: "Ações" as const, run: toggle(() => void selectSession(mode, null)) },
      { id: "settings", label: "Configurações", description: "Abre as configurações do Orbit", keywords: ["settings", "config"], group: "Ações" as const, run: toggle(() => openSettings()) },
    ]
  }, [search, browser, thinking, simple, brain, subagents, orchestra, model, enabled, variantId, update, sessionId, setBrainEnabled, setSimple, actionCommands, referenceCommands, selectSession, mode, openSettings])

  return (
    <PromptInputProvider>
    <SlashPalette commands={slashCommands}>
    <DraftInputBridge sessionId={sessionId} />
    <div className="w-full max-w-2xl mx-auto pb-4">
      <QueueIndicator sessionId={sessionId} />
      <PromptInput
        multiple
        onSubmit={(message) => {
          const files = toFileParts(message.files ?? [])
          // Comandos "/" viram o prompt do pipeline correspondente
          const resolveText = (raw: string) => {
            const resolved = resolveSlashAction(raw, "chat")
            return resolved?.prompt ?? raw
          }
          // Enter pressionado durante execução: fila ou stop
          if (busy) {
            const text = message.text?.trim()
            if (!text) {
              onStop?.()
            } else if (sessionId) {
              enqueueForSend(sessionId, resolveText(text), buildOptions(), mode, { files })
            }
            return
          }
          const text = message.text?.trim()
          if (!text) return
          return onSubmit(resolveText(text), buildOptions(), files.length > 0 ? files : undefined)
        }}
        className="rounded-xl border-2 border-sidebar-border [&>div]:!rounded-[calc(var(--radius-xl)-2px)] [&>div]:!border-none [&>div]:!bg-transparent"
      >
        <PromptInputAttachments className="!px-3 !py-1.5">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Pergunte qualquer coisa..." className="px-3 text-base md:text-base" />
        </PromptInputBody>
        <PromptInputFooter>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                <PlusIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56 p-1.5">
                {displayMode !== "toggles" && (
                  <>
                    <ModeMenuItems items={modeToggleItems} />
                    <DropdownMenuSeparator />
                  </>
                )}
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
            {displayMode === "actions" && <ContextMeter sessionId={sessionId} />}
          </div>
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
            <SendButtonGroup
              busy={busy}
              disabled={false}
              onStop={() => onStop?.()}
              onQueue={(text) => {
                if (sessionId) enqueueForSend(sessionId, text, buildOptions(), mode)
              }}
              onStopAndSend={(text) => {
                onStop?.()
                if (sessionId) enqueueForSend(sessionId, text, buildOptions(), mode)
              }}
              onSchedule={(text, timestamp) => {
                if (sessionId) enqueueScheduled(sessionId, text, buildOptions(), mode, timestamp)
              }}
              onSendToSidePanel={async (text) => {
                const newSession = await createSession(mode, { setActive: false })
                await sendMessage(mode, text, { options: buildOptions(), sessionId: newSession.id })
                openChatTab(newSession.id, newSession.title)
              }}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
      {displayMode !== "actions" && (
        <PromptInputTools>
          <div className="flex items-center gap-1 mt-2">
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
            onToggle={() => setSimple(sessionId, !simple)}
          />
          <ModeToggle
            icon={BrainCircuit}
            label="Memória"
            description="Orbit lembra fatos e preferências suas entre conversas. Desative apenas neste chat se preferir uma interação sem contexto."
            active={brain}
            onToggle={() => setBrainEnabled(sessionId, !brain)}
          />
        </div>
          <div className="ml-auto mt-2">
            <ContextMeter sessionId={sessionId} />
          </div>
        </PromptInputTools>
      )}
      <OrchestrationConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
    </div>
    </SlashPalette>
    </PromptInputProvider>
  )
}
