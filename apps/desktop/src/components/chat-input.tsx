import { useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { AlignLeft, BrainCircuit, Eye, Globe, PlusIcon, Search } from "lucide-react"
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
import { ModeMenuItems, type ModeToggleDef } from "@/src/components/mode-menu-items"
import { VisionConfigDialog } from "@/src/components/vision-config-dialog"
import { ModelPicker } from "@/src/components/model-picker"
import { ModeToggle } from "@/src/components/mode-toggle"

import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { QuickSettingsMenu } from "@/src/components/quick-settings-menu"
import { DraftInputBridge } from "@/src/components/draft-input-bridge"
import { ChatInputDraft } from "@/src/components/chat-input-draft"
import { PendingAttachmentSync } from "@/src/components/pending-attachment-sync"
import { clearInputDraft } from "@/src/stores/chat-draft"
import { QueueIndicator } from "@/src/components/queue-indicator"
import { ContextMeter } from "@/src/components/context-meter"
import { SendButtonGroup } from "@/src/components/send-button-group"
import { SlashPalette } from "@/src/components/slash-palette"
import { useReferenceCommands, useSlashActionCommands, type SlashCommand } from "@/src/lib/slash-commands"
import { useWorkspace } from "@/lib/workspace-context"
import { useBrainEnabled, useBrainPrefs, useChatContext } from "@/src/stores/brain-prefs"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useModeActive, useModeOverrides } from "@/src/stores/mode-overrides"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useReasoningPrefs } from "@/src/stores/reasoning-prefs"
import { useSimpleMode, useSimplePrefs } from "@/src/stores/simple-prefs"
import type { ChatStatus, FilePart, SendMessageOptions } from "@shared/chat"
import { toFileParts } from "@/src/lib/message-utils"
import { resolveSlashAction } from "@/src/lib/slash-actions"
import { useAppearanceStore } from "@/src/stores/appearance-store"

export function ChatInput({ onSubmit, status, onStop, sessionId, draftKey }: {
  onSubmit: (text: string, options: SendMessageOptions, files?: FilePart[]) => void
  status?: ChatStatus
  onStop?: () => void
  /** Sessão ativa — o toggle Brain é por chat (undefined = chat novo) */
  sessionId?: string
  /** Chave de rascunho própria (ex.: painel lateral, para não misturar com o chat novo do painel principal) */
  draftKey?: string
}) {
  const { t } = useTranslation()
  const chatActiveModes = useModelModePrefs((s) => s.chatActiveModes)
  const search = useModeActive("search", sessionId, chatActiveModes.search)
  const browser = useModeActive("browser", sessionId, chatActiveModes.browser)
  const setModeActive = useModeOverrides((s) => s.setMode)
  const simple = useSimpleMode(sessionId, chatActiveModes.simple)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const brain = useBrainEnabled(sessionId, chatActiveModes.brain)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)
  const brainContext = useChatContext()
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  const { enabled, variantId, update } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  // Thinking: o chip das preferências define o default; reasoning do modelo e
  // modelos com reasoningAlwaysOn continuam valendo como antes
  const thinking = chatActiveModes.thinking || enabled || !!model?.reasoningAlwaysOn
  const busy = status === "submitted" || status === "streaming" || status === "cancelling"

  const visionModel = useProviderStore((s) => s.visionModel)
  const vision = useModeActive("vision", sessionId, chatActiveModes.vision)
  const setVisionConfigOpen = useProviderStore((s) => s.setVisionConfigOpen)
  const visionConfigOpen = useProviderStore((s) => s.visionConfigOpen)

  const { mode } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  const openSettings = useSettingsUi((s) => s.openSettings)
  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const createSession = useSessionStore((s) => s.createSession)
  const openChatTab = usePanelStore((s) => s.openChatTab)
  const modesInRow = useAppearanceStore((s) => s.modesInRow)
  const modeLabelStyle = useAppearanceStore((s) => s.modeLabelStyle)
  const referenceCommands = useReferenceCommands("chat")
  const actionCommands = useSlashActionCommands("chat")

  const modeToggleItems = useMemo<ModeToggleDef[]>(() => [
    { icon: Search, label: t("input.modes.search.label"), active: search, onChange: (v: boolean) => setModeActive("search", sessionId, v) },
    { icon: Globe, label: t("input.modes.browser.label"), active: browser, onChange: (v: boolean) => setModeActive("browser", sessionId, v) },
    { icon: AlignLeft, label: t("input.modes.simple.label"), active: simple, onChange: (v: boolean) => setSimple(sessionId, v) },
    { icon: BrainCircuit, label: t("input.modes.brain.label"), active: brain, onChange: (v: boolean) => setBrainEnabled(sessionId, v) },
    {
      icon: Eye,
      label: t("input.modes.vision.label"),
      active: vision,
      onChange: (v: boolean) => {
        // Primeira ativação sem modelo configurado → abre a configuração;
        // depois disso o toggle só liga/desliga (a configuração fica guardada)
        if (v && !visionModel) setVisionConfigOpen(true)
        else setModeActive("vision", sessionId, v)
      },
      onConfig: () => setVisionConfigOpen(true),
    },
  ], [search, browser, simple, brain, vision, visionModel, sessionId, setBrainEnabled, setSimple, setModeActive, setVisionConfigOpen, t])

  const buildOptions = useCallback((): SendMessageOptions => ({
    research: search,
    browser,
    simple,
    brain,
    brainContext: brainContext === "all" ? true : brainContext === "memory" ? brain : false,
    reasoning: { enabled: thinking, variantId },
  }), [search, browser, simple, brain, brainContext, thinking, variantId])

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText("")
    }
    return [
      { id: "pesquisa", label: t("input.modes.search.label"), description: t("input.slash.searchDescription"), keywords: ["web", "search"], group: "Modos" as const, active: search, run: toggle(() => setModeActive("search", sessionId, !search)) },
      { id: "browser", label: t("input.modes.browser.label"), description: t("input.slash.browserDescription"), keywords: ["navegador", "web"], group: "Modos" as const, active: browser, run: toggle(() => setModeActive("browser", sessionId, !browser)) },
      { id: "simples", label: t("input.modes.simple.label"), description: t("input.slash.simpleDescription"), keywords: ["texto", "plain"], group: "Modos" as const, active: simple, run: toggle(() => setSimple(sessionId, !simple)) },
      { id: "brain", label: t("input.slash.brainLabel"), description: t("input.slash.brainDescription"), keywords: ["memoria", "brain"], group: "Modos" as const, active: brain, run: toggle(() => setBrainEnabled(sessionId, !brain)) },
      ...actionCommands,
      ...referenceCommands,
      { id: "novo-chat", label: t("input.slash.newChat"), description: t("input.slash.newChatDescription"), keywords: ["clear", "limpar", "novo"], group: "Ações" as const, run: toggle(() => void selectSession(mode, null)) },
      { id: "settings", label: t("input.slash.settings"), description: t("input.slash.settingsDescription"), keywords: ["settings", "config"], group: "Ações" as const, run: toggle(() => openSettings()) },
    ]
  }, [search, browser, simple, brain, sessionId, setBrainEnabled, setSimple, setModeActive, actionCommands, referenceCommands, selectSession, mode, openSettings, t])

  return (
    <PromptInputProvider>
    <SlashPalette commands={slashCommands}>
    <DraftInputBridge sessionId={sessionId} />
    <ChatInputDraft sessionId={sessionId} draftKey={draftKey} />
    <PendingAttachmentSync sessionId={sessionId} draftKey={draftKey} />
    <div className="w-full max-w-2xl mx-auto pb-4 @container">
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
          // Enter durante execução: com texto, enfileira; sem texto, não faz
          // NADA — parar é intencional (botão de stop ou Tab+Enter nele);
          // nunca "resposta em branco" para cancelar.
          if (busy) {
            const text = message.text?.trim()
            if (!text) return
            if (sessionId) {
              enqueueForSend(sessionId, resolveText(text), buildOptions(), mode, { files })
              clearInputDraft(sessionId)
            }
            return
          }
          const text = message.text?.trim()
          if (!text) return
          if (sessionId) clearInputDraft(sessionId)
          return onSubmit(resolveText(text), buildOptions(), files.length > 0 ? files : undefined)
        }}
        className="rounded-xl border-2 border-sidebar-border [&>div]:!rounded-[calc(var(--radius-xl)-2px)] [&>div]:!border-none [&>div]:!bg-transparent"
      >
        <PromptInputAttachments className="!px-3 !py-1.5">
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea placeholder={t("input.placeholder")} className="px-3 text-base md:text-base" />
        </PromptInputBody>
        <PromptInputFooter>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground">
                <PlusIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56 p-1.5">
                <ModeMenuItems items={modeToggleItems} />
                <DropdownMenuSeparator />
                <PromptInputActionAddAttachments label={t("input.attachFiles")} />
              </DropdownMenuContent>
            </DropdownMenu>
            <QuickSettingsMenu sessionId={sessionId} />
          </div>
          <div className="flex items-center gap-1">
            <div className="hidden @xl:flex items-center gap-1">
              {model?.variants && model.variants.length > 0 && (
                <ReasoningPicker
                  variants={model.variants}
                  enabled={thinking}
                  canDisable={!model.reasoningAlwaysOn}
                  selected={variantId}
                  onSelect={(id) => update({ enabled: id != null, variantId: id ?? undefined })}
                />
              )}
              <ModelPicker sessionId={sessionId} />
            </div>
            <SendButtonGroup
              busy={busy}
              cancelling={status === "cancelling"}
              disabled={false}
              onStop={() => onStop?.()}
              onQueue={(text, files) => {
                if (sessionId) enqueueForSend(sessionId, text, buildOptions(), mode, { files: toFileParts(files ?? []) })
              }}
              onStopAndSend={(text, files) => {
                onStop?.()
                if (sessionId) enqueueForSend(sessionId, text, buildOptions(), mode, { files: toFileParts(files ?? []) })
              }}
              onSchedule={(text, timestamp, files) => {
                if (sessionId) enqueueScheduled(sessionId, text, buildOptions(), mode, timestamp, { files: toFileParts(files ?? []) })
              }}
              onSendToSidePanel={async (text, files) => {
                // Novo chat na mesma pasta da sessão atual (se ela estiver em uma)
                const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                const newSession = await createSession(mode, { setActive: false, folderId: current?.folderId ?? null })
                await sendMessage(mode, text, { options: buildOptions(), sessionId: newSession.id, files: toFileParts(files ?? []) })
                openChatTab(newSession.id, newSession.title)
              }}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
      <PromptInputTools>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {modesInRow.includes("search") && (
            <ModeToggle
              icon={Search}
              label={t("input.modes.search.label")}
              description={t("input.modes.search.description")}
              active={search}
              onToggle={() => setModeActive("search", sessionId, !search)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("browser") && (
            <ModeToggle
              icon={Globe}
              label={t("input.modes.browser.label")}
              description={t("input.modes.browser.description")}
              active={browser}
              onToggle={() => setModeActive("browser", sessionId, !browser)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("simple") && (
            <ModeToggle
              icon={AlignLeft}
              label={t("input.modes.simple.label")}
              description={t("input.modes.simple.description")}
              active={simple}
              onToggle={() => setSimple(sessionId, !simple)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("brain") && (
            <ModeToggle
              icon={BrainCircuit}
              label={t("input.modes.brain.label")}
              description={t("input.modes.brain.description")}
              active={brain}
              onToggle={() => setBrainEnabled(sessionId, !brain)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("vision") && (
            <ModeToggle
              icon={Eye}
              label={t("input.modes.vision.label")}
              description={t("input.modes.vision.description")}
              active={vision}
              onToggle={() => {
                if (vision) setModeActive("vision", sessionId, false)
                else if (visionModel) setModeActive("vision", sessionId, true)
                else setVisionConfigOpen(true)
              }}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
        </div>
        <div className="ml-auto mt-2">
          <ContextMeter sessionId={sessionId} />
        </div>
      </PromptInputTools>
    </div>
    <VisionConfigDialog open={visionConfigOpen} onOpenChange={setVisionConfigOpen} targetSession={sessionId} />
    </SlashPalette>
    </PromptInputProvider>
  )
}
