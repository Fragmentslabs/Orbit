import { useEffect, useMemo, useState } from "react"
import { AlignLeft, Bot, Brain, BrainCircuit, FileText, MousePointerClick, Network, PlusIcon, Search, X } from "lucide-react"
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
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/src/components/ai/prompt-input"
import { DelegationMenuItems } from "@/src/components/delegation-menu"
import { ModelPicker } from "@/src/components/model-picker"
import { ModeToggle } from "@/src/components/mode-toggle"
import { OrchestrationConfigDialog } from "@/src/components/orchestration-config-dialog"
import { PermissionModePicker } from "@/src/components/permission-mode-picker"
import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { DraftInputBridge } from "@/src/components/draft-input-bridge"
import { SlashPalette, useReferenceCommands, type SlashCommand } from "@/src/components/slash-palette"
import { FolderSelector } from "@/src/components/folder-selector"
import { useWorkspace } from "@/lib/workspace-context"
import { useBrainEnabled, useBrainPrefs } from "@/src/stores/brain-prefs"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useSimpleMode } from "@/src/stores/simple-mode"
import { useSkillsStore } from "@/src/stores/skills-store"
import type { ChatStatus, PermissionMode, SendMessageOptions } from "@/shared/chat"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function saveRecentFolders(folders: string[]) {
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
}

export function CodeInput({ onSubmit, status, onStop, hasMessages, sessionId }: {
  onSubmit: (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[]) => void
  status?: ChatStatus
  onStop?: () => void
  hasMessages?: boolean
  /** Sessão ativa — o toggle Brain é por chat (undefined = chat novo) */
  sessionId?: string
}) {
  const [plan, setPlan] = useState(false)
  const [search, setSearch] = useState(false)
  const [subagents, setSubagents] = useState(false)
  const [orchestra, setOrchestra] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const simple = useSimpleMode((s) => s.simple)
  const setSimple = useSimpleMode((s) => s.setSimple)
  const brain = useBrainEnabled(sessionId)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)
  const permissionMode = usePermissionPrefs((s) => s.mode)
  const setPermissionMode = usePermissionPrefs((s) => s.setMode)
  const { folders, setFolders } = useWorkspace()

  // Skills de projeto (.orbit/skills) acompanham a pasta principal ativa
  useEffect(() => {
    void useSkillsStore.getState().refresh(folders[0])
  }, [folders])
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
    let text = message.text?.trim()
    if (!text || folders.length === 0) return
    saveRecentFolders(folders)
    const [directory, ...extraDirectories] = folders
    // Elementos selecionados no browser do painel viram anexos da mensagem
    const selections = usePanelStore.getState().selections
    if (selections.length > 0) {
      text += `\n\n${selections
        .map(
          (sel) =>
            `[Elemento selecionado no browser do painel — <${sel.tag}> em ${sel.url}]\nselector: ${sel.selector}\ntexto: ${sel.text || "(sem texto)"}\nhtml: ${sel.html}`,
        )
        .join("\n\n")}`
      usePanelStore.getState().clearSelections()
    }
    onSubmit(
      text,
      {
        plan,
        research: search,
        simple,
        brain,
        permissionMode,
        reasoning: { enabled: thinking, variantId },
        subagents,
        orchestrate: orchestra ? {} : undefined,
      },
      directory,
      extraDirectories,
    )
  }

  const { mode } = useWorkspace()
  const openSettings = useSettingsUi((s) => s.openSettings)
  const referenceCommands = useReferenceCommands()
  const selections = usePanelStore((s) => s.selections)
  const removeSelection = usePanelStore((s) => s.removeSelection)

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText("")
    }
    const permission = (id: PermissionMode, label: string, description: string): SlashCommand => ({
      id: `perm-${id}`,
      label: `Permissões: ${label}`,
      description,
      keywords: ["permissao", "autonomia", id],
      group: "Modos",
      active: permissionMode === id,
      run: toggle(() => setPermissionMode(id)),
    })
    return [
      { id: "pesquisa", label: "Pesquisa", description: "Alterna busca web para documentação", keywords: ["web", "search"], group: "Modos" as const, active: search, run: toggle(() => setSearch((v) => !v)) },
      { id: "plano", label: "Modo Plano", description: "Alterna modo somente leitura (plano de implementação)", keywords: ["plan", "leitura"], group: "Modos" as const, active: plan, run: toggle(() => setPlan((v) => !v)) },
      ...(model?.reasoning && !model.reasoningAlwaysOn
        ? [{ id: "thinking", label: "Thinking", description: "Alterna raciocínio estendido do modelo", keywords: ["reasoning", "pensar"], group: "Modos" as const, active: thinking, run: toggle(() => update({ enabled: !enabled, variantId })) }]
        : []),
      { id: "simples", label: "Simples", description: "Alterna respostas em texto puro", keywords: ["texto", "plain"], group: "Modos" as const, active: simple, run: toggle(() => setSimple(!simple)) },
      { id: "brain", label: "Memória (Brain)", description: "Alterna a memória do projeto neste chat", keywords: ["memoria", "brain"], group: "Modos" as const, active: brain, run: toggle(() => setBrainEnabled(sessionId, !brain)) },
      { id: "subagents", label: "Subagents", description: "Alterna workers em background", keywords: ["worker", "delegar"], group: "Modos" as const, active: subagents, run: toggle(() => setSubagents((v) => !v)) },
      { id: "orchestra", label: "Orchestra", description: "Alterna orquestração em tarefas paralelas", keywords: ["workers", "plano"], group: "Modos" as const, active: orchestra, run: toggle(() => setOrchestra((v) => !v)) },
      permission("ask", "Perguntar", "Confirma ações sensíveis antes de executar"),
      permission("approve", "Autonomia", "Executa sozinho; ações críticas pedem confirmação"),
      permission("full", "Irrestrito", "Sem perguntas (piso de segurança mantido)"),
      ...referenceCommands,
      { id: "nova-sessao", label: "Nova sessão", description: "Começa uma sessão de código em branco", keywords: ["clear", "limpar", "novo"], group: "Ações" as const, run: toggle(() => void useSessionStore.getState().selectSession(mode, null)) },
      { id: "create-skill", label: "Criar skill", description: "Pede ao Orbit para criar uma skill (com scripts, se precisar)", keywords: ["skill", "criar", "aprender"], group: "Ações" as const, run: ({ setText }) => setText("/create-skill ") },
      { id: "document", label: "Documentar aplicação", description: "Navega pelo app no painel, tira screenshots e documenta em docs/", keywords: ["docs", "documentacao", "screenshot"], group: "Ações" as const, run: ({ setText }) => setText("/document ") },
      { id: "settings", label: "Configurações", description: "Abre as configurações do Orbit", keywords: ["settings", "config"], group: "Ações" as const, run: toggle(() => openSettings()) },
    ]
  }, [search, plan, thinking, simple, brain, subagents, orchestra, permissionMode, model, enabled, variantId, update, sessionId, setBrainEnabled, setSimple, setPermissionMode, referenceCommands, mode, openSettings])

  return (
    <PromptInputProvider>
      <SlashPalette commands={slashCommands}>
      <DraftInputBridge />
      <div className="w-full max-w-2xl mx-auto pb-4">
        {(!hasMessages || folders.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
            <FolderSelector folders={folders} onFoldersChange={setFolders} />
            <PromptInputAttachments className="!p-0 !m-0 !w-auto">
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
          </div>
        )}
        {/* Elementos selecionados no browser do painel (modo seleção) */}
        {selections.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
            {selections.map((sel) => (
              <span
                key={sel.id}
                title={`${sel.selector}\n"${sel.text}"`}
                className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
              >
                <MousePointerClick className="size-3" />
                {"<"}{sel.tag}{">"} {sel.text ? `"${sel.text.slice(0, 24)}${sel.text.length > 24 ? "…" : ""}"` : "selecionado"}
                <button
                  type="button"
                  onClick={() => removeSelection(sel.id)}
                  className="ml-0.5 rounded-sm hover:bg-emerald-500/20"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
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
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                  <PlusIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56 p-1.5">
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
              <PermissionModePicker onOpenSettings={(tab) => useSettingsUi.getState().openSettings(tab)} />
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
              <PromptInputSubmit
                disabled={(!selected || folders.length === 0) && !busy}
                status={busy ? (status === "submitted" ? "submitted" : "streaming") : undefined}
              />
            </div>
          </PromptInputFooter>
        </PromptInput>
        <PromptInputTools>
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
          <ModeToggle
            icon={AlignLeft}
            label="Simples"
            description="Respostas diretas em texto puro: sem formatação nem blocos de ferramentas."
            active={simple}
            onToggle={() => setSimple(!simple)}
          />
          <ModeToggle
            icon={BrainCircuit}
            label="Memória"
            description="Memória do projeto entre sessões: decisões, convenções e estrutura. Desative apenas neste chat."
            active={brain}
            onToggle={() => setBrainEnabled(sessionId, !brain)}
          />
        </PromptInputTools>
        <OrchestrationConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
      </div>
      </SlashPalette>
    </PromptInputProvider>
  )
}
