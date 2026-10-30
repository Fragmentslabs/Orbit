import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlignLeft, BrainCircuit, Clapperboard, Eye, Globe, LayoutGrid, Monitor, PlusIcon, Quote, Search, X } from "lucide-react"
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
import { ToolsPopover } from "@/src/components/tools-popover"
import { VisionConfigDialog } from "@/src/components/vision-config-dialog"
import { ModelPicker } from "@/src/components/model-picker"
import { ModeToggle } from "@/src/components/mode-toggle"

import { ReasoningPicker } from "@/src/components/reasoning-picker"
import { QuickSettingsMenu } from "@/src/components/quick-settings-menu"
import { DraftInputBridge } from "@/src/components/draft-input-bridge"
import { ChatInputDraft } from "@/src/components/chat-input-draft"
import { ReplyBar } from "@/src/components/reply-bar"
import { withReplyPrefix } from "@/src/stores/message-reply"
import { DictationButton } from "@/src/components/dictation-button"
import { VoiceCallButton, VoiceCallPanel, useHostedVoiceCallControl } from "@/src/components/voice-call"
import { PendingAttachmentSync } from "@/src/components/pending-attachment-sync"
import { clearInputDraft } from "@/src/stores/chat-draft"
import { QueueIndicator } from "@/src/components/queue-indicator"
import { ContextMeter } from "@/src/components/context-meter"
import { SendButtonGroup } from "@/src/components/send-button-group"
import { SlashPalette } from "@/src/components/slash-palette"
import { ReferencePalette } from "@/src/components/reference-palette"
import { useSlashActionCommands, type SlashCommand } from "@/src/lib/slash-commands"
import { useWorkspace } from "@/lib/workspace-context"
import { useBrainEnabled, useBrainPrefs, useChatContext } from "@/src/stores/brain-prefs"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useModeActive, useModeOverrides } from "@/src/stores/mode-overrides"
import { useComputerMode } from "@/src/stores/computer-mode"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore, useNoProviderConnected } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useSessionReasoningPref } from "@/src/stores/session-reasoning"
import { usePromptSuggestion } from "@/src/stores/prompt-suggestion"
import { useSimpleMode, useSimplePrefs } from "@/src/stores/simple-prefs"
import { useToolsServers } from "@/src/stores/session-tools"
import type { ChatStatus, FilePart, SendMessageOptions } from "@shared/chat"
import { closestVariant } from "@shared/chat"
import { quoteChipLabel, quoteChipTitle, quotesToFileParts } from "@/src/lib/document-quote"
import { toFileParts } from "@/src/lib/message-utils"
import { useInputHistory } from "@/src/hooks/use-input-history"
import { resolveSlashAction } from "@/src/lib/slash-actions"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import { Hint } from "@/components/ui/hint"

export function ChatInput({ onSubmit, status, onStop, sessionId, draftKey, onProviderBlocked }: {
  onSubmit: (text: string, options: SendMessageOptions, files?: FilePart[]) => void
  status?: ChatStatus
  onStop?: () => void
  /** Active session — the Brain toggle is per chat (undefined = new chat) */
  sessionId?: string
  /** Its own draft key (e.g. side panel, so it does not mix with the main panel's new chat) */
  draftKey?: string
  /** No provider configured and the user tried to send — whoever renders the card decides how to react */
  onProviderBlocked?: () => void
}) {
  const { t } = useTranslation()
  // Draft key (and of the replied message): the same rule as
  // ChatInputDraft, so the quote of one chat does not appear in another.
  const replyKey = draftKey ?? sessionId ?? "draft"
  // ↑/↓ bring back the texts already sent in this chat.
  const navigateHistory = useInputHistory(sessionId, replyKey)
  const quotes = usePanelStore((s) => s.quotes)
  const removeQuote = usePanelStore((s) => s.removeQuote)
  const chatActiveModes = useModelModePrefs((s) => s.chatActiveModes)
  const search = useModeActive("search", sessionId, chatActiveModes.search)
  const browser = useModeActive("browser", sessionId, chatActiveModes.browser)
  const computer = useComputerMode(sessionId)
  const setModeActive = useModeOverrides((s) => s.setMode)
  const simple = useSimpleMode(sessionId, chatActiveModes.simple)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const brain = useBrainEnabled(sessionId, chatActiveModes.brain)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)
  const brainContext = useChatContext()
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  // Thinking PER CHAT: the selector saves the choice of this conversation; without it, the
  // model level defined in Preferences applies.
  const { enabled, variantId: savedVariant, update } = useSessionReasoningPref(sessionId, selected?.providerId, selected?.modelId)
  const suggestion = usePromptSuggestion(sessionId)
  // A saved level this model does not offer (e.g. "medium" where there is only
  // low/high/max) becomes the nearest neighbor — the same one the engine sends.
  const variantId = closestVariant(model?.variants?.map((v) => v.id) ?? [], savedVariant) ?? savedVariant
  // Thinking: the preferences chip defines the default; the model's reasoning and
  // models with reasoningAlwaysOn keep applying as before
  const thinking = chatActiveModes.thinking || enabled || !!model?.reasoningAlwaysOn
  const busy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  // Pre-configuration (no provider): sending is blocked via onSubmitCapture —
  // in CAPTURE, before PromptInput's handleSubmit clears the input — so the
  // user's text is not lost; onProviderBlocked shows the explanatory card
  const noProvider = useNoProviderConnected()

  const visionModel = useProviderStore((s) => s.visionModel)
  const vision = useModeActive("vision", sessionId, chatActiveModes.vision)
  const setVisionConfigOpen = useProviderStore((s) => s.setVisionConfigOpen)
  const visionConfigOpen = useProviderStore((s) => s.visionConfigOpen)
  // MCP servers: a FIXED control in the footer, not a mode — it narrows which
  // servers this conversation sees (the tools themselves have no on/off).
  const toolsServers = useToolsServers(sessionId)
  // Controlled "+" menu so it can CLOSE before opening a settings
  // modal: the menu popup lives above the modals and would cover them.
  const [addMenuOpen, setAddMenuOpen] = useState(false)

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
        // First activation with no model configured → opens the settings;
        // after that the toggle only turns on/off (the settings stay stored)
        if (v && !visionModel) setVisionConfigOpen(true)
        else setModeActive("vision", sessionId, v)
      },
      onConfig: () => {
        setAddMenuOpen(false)
        setVisionConfigOpen(true)
      },
    },
    // Computer: only appears with the Preferences switch on.
    ...(computer.visible
      ? [{ icon: Monitor, label: t("input.modes.computer.label"), active: computer.active, onChange: (v: boolean) => setModeActive("computer", sessionId, v) }]
      : []),
  ], [search, browser, simple, brain, vision, visionModel, computer.visible, computer.active, sessionId, setBrainEnabled, setSimple, setModeActive, setVisionConfigOpen, t])

  const buildOptions = useCallback((): SendMessageOptions => ({
    research: search,
    browser,
    simple,
    brain,
    brainContext: brainContext === "all" ? true : brainContext === "memory" ? brain : false,
    reasoning: { enabled: thinking, variantId },
    toolsServers: toolsServers ?? undefined,
    computer: computer.active || undefined,
  }), [search, browser, simple, brain, brainContext, thinking, variantId, toolsServers, computer.active])

  /** The call's turn already tied to ONE session: it never uses the active session. The
   *  busy state is read from the store at the instant of the utterance — the call may
   *  be running with the owner's composer unmounted, so nothing here can
   *  depend on the chat that happens to be open. */
  const submitVoiceTo = useCallback(
    (targetSessionId: string, text: string): boolean => {
      if (noProvider) {
        onProviderBlocked?.()
        return false
      }
      const options = { ...buildOptions(), voiceCall: true }
      const statusNow = useSessionStore.getState().status[targetSessionId]
      const busyNow = statusNow === "submitted" || statusNow === "streaming" || statusNow === "cancelling" || statusNow === "fallback"
      if (busyNow) {
        enqueueForSend(targetSessionId, text, options, "chat", { files: [] })
        return true
      }
      void sendMessage("chat", text, { options, sessionId: targetSessionId, files: [] })
      return true
    },
    [noProvider, onProviderBlocked, buildOptions, enqueueForSend, sendMessage],
  )
  /** The call submit of THIS composer, tied to its session. */
  const submitVoiceToSession = useCallback(
    (text: string): boolean => (sessionId ? submitVoiceTo(sessionId, text) : false),
    [sessionId, submitVoiceTo],
  )
  /** New chat: creates the session that owns the call before dialing. */
  const createCallSession = useCallback(async () => {
    const created = await createSession("chat", { setActive: false })
    void selectSession("chat", created.id)
    return {
      sessionId: created.id,
      submit: (text: string) => submitVoiceTo(created.id, text),
    }
  }, [createSession, selectSession, submitVoiceTo])
  const voiceCall = useHostedVoiceCallControl({
    sessionId,
    mode: "chat",
    submit: submitVoiceToSession,
    createCallSession,
  })
  // The call session's composer keeps the host with the most recent submit
  // (folders/modes/queue change). The call itself never changes recipient.
  const registerVoiceSubmit = voiceCall.registerSubmit
  useEffect(() => {
    if (voiceCall.call.active && voiceCall.isCallSession) registerVoiceSubmit(submitVoiceToSession)
  }, [voiceCall.call.active, voiceCall.isCallSession, registerVoiceSubmit, submitVoiceToSession])

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText("")
    }
    return [
      { id: "search", label: t("input.modes.search.label"), description: t("input.slash.searchDescription"), keywords: ["web", "search"], group: "Modes" as const, active: search, run: toggle(() => setModeActive("search", sessionId, !search)) },
      { id: "browser", label: t("input.modes.browser.label"), description: t("input.slash.browserDescription"), keywords: ["browser", "web"], group: "Modes" as const, active: browser, run: toggle(() => setModeActive("browser", sessionId, !browser)) },
      { id: "plain", label: t("input.modes.simple.label"), description: t("input.slash.simpleDescription"), keywords: ["plain", "text"], group: "Modes" as const, active: simple, run: toggle(() => setSimple(sessionId, !simple)) },
      { id: "brain", label: t("input.slash.brainLabel"), description: t("input.slash.brainDescription"), keywords: ["memory", "brain"], group: "Modes" as const, active: brain, run: toggle(() => setBrainEnabled(sessionId, !brain)) },
      // Vision: first activation with no model configured opens the settings.
      { id: "vision", label: t("input.modes.vision.label"), description: t("input.modes.vision.description"), keywords: ["vision", "image"], group: "Modes" as const, active: vision, run: toggle(() => {
        if (!vision && !visionModel) setVisionConfigOpen(true)
        else setModeActive("vision", sessionId, !vision)
      }) },
      ...actionCommands,
      { id: "new-chat", label: t("input.slash.newChat"), description: t("input.slash.newChatDescription"), keywords: ["clear", "reset", "new"], group: "Actions" as const, run: toggle(() => void selectSession(mode, null)) },
      { id: "settings", label: t("input.slash.settings"), description: t("input.slash.settingsDescription"), keywords: ["settings", "config"], group: "Actions" as const, run: toggle(() => openSettings()) },
    ]
  }, [search, browser, simple, brain, vision, visionModel, sessionId, setBrainEnabled, setSimple, setModeActive, setVisionConfigOpen, actionCommands, selectSession, mode, openSettings, t])

  return (
    <PromptInputProvider>
    <ReferencePalette servers={toolsServers}>
    <SlashPalette commands={slashCommands} className="mx-auto w-full max-w-2xl">
    <DraftInputBridge sessionId={sessionId} />
    <ChatInputDraft sessionId={sessionId} draftKey={draftKey} />
    <PendingAttachmentSync sessionId={sessionId} draftKey={draftKey} />
    <div className="w-full max-w-2xl mx-auto pb-4 @container">
      {quotes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
          {quotes.map((q) => (
            <span
              key={q.id}
              title={quoteChipTitle(q)}
              className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
            >
              {/* The icon says where the attachment came from without spending space: an excerpt of a
                  document or an instant of a composition. */}
              {q.kind === "motion" ? (
                <Clapperboard className="size-3" />
              ) : q.kind === "design" ? (
                <LayoutGrid className="size-3" />
              ) : (
                <Quote className="size-3" />
              )}
              {quoteChipLabel(q)}
              <Hint label={t("common.remove")}>
                <button
                  type="button"
                  onClick={() => removeQuote(q.id)}
                  className="ml-0.5 cursor-pointer rounded-sm hover:bg-primary/20"
                >
                  <X className="size-3" />
                </button>
              </Hint>
            </span>
          ))}
        </div>
      )}
      <QueueIndicator sessionId={sessionId} />
      <PromptInput
        multiple
        onSubmitCapture={noProvider ? (e) => {
          e.preventDefault()
          e.stopPropagation()
          onProviderBlocked?.()
        } : undefined}
        onSubmit={(message) => {
          // Editing a queue item (pencil in the queue): Enter saves the edit in the
          // SAME item — the queue order does not change — instead of queueing another
          // message. With the input empty Enter only cancels the edit and the
          // normal flow goes on (with no text, Enter does nothing here).
          const editingId = sessionId ? useMessageQueueStore.getState().editing[sessionId] : undefined
          const rawText = message.text?.trim()
          if (editingId && sessionId) {
            if (rawText) {
              const resolved = resolveSlashAction(rawText, "chat")
              useMessageQueueStore.getState().update(sessionId, editingId, resolved?.prompt ?? rawText)
              useMessageQueueStore.getState().cancelEdit(sessionId)
              clearInputDraft(sessionId)
              return
            }
            useMessageQueueStore.getState().cancelEdit(sessionId)
          }
          const files = toFileParts(message.files ?? [])
          // Excerpts quoted from the viewer become an attachment with its own MIME: the
          // bubble shows the chip and the model receives the text with the quote.
          const quoteFiles = quotesToFileParts(quotes)
          if (quoteFiles.length > 0) {
            files.push(...quoteFiles)
            usePanelStore.getState().clearQuotes()
          }
          // "/" commands become the prompt of the corresponding pipeline
          const resolveText = (raw: string) => {
            const resolved = resolveSlashAction(raw, "chat")
            return resolved?.prompt ?? raw
          }
          // Enter during execution: with text, it queues; with no text, it does
          // NOTHING — stopping is intentional (stop button or Tab+Enter on it);
          // never an "empty reply" to cancel. AN ATTACHMENT counts as
          // content: large pasted text becomes a file and leaves the field empty.
          if (busy) {
            const text = message.text?.trim()
            if (!text && files.length === 0) return
            if (sessionId) {
              enqueueForSend(sessionId, withReplyPrefix(replyKey, resolveText(text)), buildOptions(), mode, { files })
              clearInputDraft(sessionId)
            }
            return
          }
          const text = message.text?.trim()
          // No text but WITH an attachment is still a message: the chip alone is content.
          // It still blocks the blank Enter, which is the case the lock exists
          // to cover.
          if (!text && files.length === 0) return
          if (sessionId) clearInputDraft(sessionId)
          // The quote is prepended AFTER the "/" command is resolved: in
          // front of it, the text would no longer start with "/" and the command
          // would become conversation.
          return onSubmit(withReplyPrefix(replyKey, resolveText(text)), buildOptions(), files.length > 0 ? files : undefined)
        }}
        className="relative rounded-xl border-2 border-sidebar-border [&>div]:!rounded-[calc(var(--radius-xl)-2px)] [&>div]:!border-none [&>div]:!bg-transparent"
      >
        <PromptInputAttachments className="!px-3 !py-1.5" leading={<ReplyBar replyKey={replyKey} />}>
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          {/* The microphone is anchored to the LINE of the textarea, and not to the top of the
              box: that way it follows the text where it starts, even if some
              line comes in above the box. */}
          <div className="relative w-full">
            {/* TOP right corner, at the level of the first line of the text:
                absolute so it does not push the content, with the slack on the right
                reserved in the textarea itself (pr-10). */}
            <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5">
              <VoiceCallPanel control={voiceCall} />
              <DictationButton sessionId={sessionId} />
            </div>
            <PromptInputTextarea
              placeholder={t("input.placeholder")}
              suggestion={suggestion}
              onHistory={navigateHistory}
              className="px-3 pr-10 text-base md:text-base"
            />
          </div>
        </PromptInputBody>
        <PromptInputFooter>
          <div className="flex items-center gap-1">
            <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
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
              emptySlot={
                // The panel's new chat creates the session in a tab without activating it; the
                // call would be born without a session. There only the shortcut to an
                // existing call fits; to start one, open the conversation.
                voiceCall.inSlot && (!!sessionId || !draftKey || voiceCall.call.active) ? (
                  <VoiceCallButton control={voiceCall} />
                ) : undefined
              }
              emptySlotAlways={voiceCall.call.active && voiceCall.isCallSession}
              busy={busy}
              cancelling={status === "cancelling"}
              disabled={false}
              onStop={() => onStop?.()}
              onQueue={(text, files) => {
                if (sessionId) enqueueForSend(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, { files: toFileParts(files ?? []) })
              }}
              onStopAndSend={(text, files) => {
                onStop?.()
                if (sessionId) enqueueForSend(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, { files: toFileParts(files ?? []) })
              }}
              onSchedule={(text, timestamp, files) => {
                if (sessionId) enqueueScheduled(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, timestamp, { files: toFileParts(files ?? []) })
              }}
              onSendToSidePanel={async (text, files) => {
                // New chat in the same folder as the current session (if it is in one)
                const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                const newSession = await createSession(mode, { setActive: false, folderId: current?.folderId ?? null })
                await sendMessage(mode, withReplyPrefix(replyKey, text), { options: buildOptions(), sessionId: newSession.id, files: toFileParts(files ?? []) })
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
              onConfig={() => setVisionConfigOpen(true)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {/* Computer: in the bar only if enabled in Appearance (default: hidden) and
              with the Preferences → Computer switch on. */}
          {computer.visible && modesInRow.includes("computer") && (
            <ModeToggle
              icon={Monitor}
              label={t("input.modes.computer.label")}
              description={t("input.modes.computer.description")}
              active={computer.active}
              onToggle={() => setModeActive("computer", sessionId, !computer.active)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
        </div>
        <div className="ml-auto mt-2 flex items-center gap-0.5">
          <ToolsPopover sessionId={sessionId} iconOnly={modeLabelStyle === "icon"} />
          <ContextMeter sessionId={sessionId} />
        </div>
      </PromptInputTools>
    </div>
    <VisionConfigDialog open={visionConfigOpen} onOpenChange={setVisionConfigOpen} targetSession={sessionId} />
    </SlashPalette>
    </ReferencePalette>
    </PromptInputProvider>
  )
}
