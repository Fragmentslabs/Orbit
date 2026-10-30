import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlignLeft, Bot, BrainCircuit, Clapperboard, Eye, FileText, LayoutGrid, Monitor, MousePointerClick, Network, PlusIcon, Quote, RefreshCw, Search, X } from "lucide-react"
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
import { ToolsPopover } from "@/src/components/tools-popover"
import { VisionConfigDialog } from "@/src/components/vision-config-dialog"
import { LoopConfigDialog } from "@/src/components/loop-config-dialog"
import { ModelPicker } from "@/src/components/model-picker"
import { ModeToggle } from "@/src/components/mode-toggle"
import { OrchestrationConfigDialog, type DelegationConfigKind } from "@/src/components/orchestration-config-dialog"
import { PermissionModePicker } from "@/src/components/permission-mode-picker"
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
import { useInputHistory } from "@/src/hooks/use-input-history"
import { FolderSelector } from "@/src/components/folder-selector"
import { FolderHintCard } from "@/src/components/folder-hint-card"
import { useWorkspace } from "@/lib/workspace-context"
import { useBrainEnabled, useBrainPrefs, useCodeContext } from "@/src/stores/brain-prefs"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useModeActive, useModeOverrides } from "@/src/stores/mode-overrides"
import { useComputerMode } from "@/src/stores/computer-mode"
import { usePanelStore } from "@/src/stores/panel-store"
import { quoteChipLabel, quoteChipTitle, quotesToFileParts } from "@/src/lib/document-quote"
import { usePermissionMode, usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore, useNoProviderConnected } from "@/src/stores/provider-store"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useSessionReasoningPref } from "@/src/stores/session-reasoning"
import { usePromptSuggestion } from "@/src/stores/prompt-suggestion"
import { useSessionStore } from "@/src/stores/session-store"
import { useSimpleMode, useSimplePrefs } from "@/src/stores/simple-prefs"
import { useToolsServers } from "@/src/stores/session-tools"
import { useSkillsStore } from "@/src/stores/skills-store"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import type { ChatStatus, FilePart, PermissionMode, SendMessageOptions } from "@shared/chat"
import { BROWSER_SELECTION_MIME, closestVariant } from "@shared/chat"
import { toFileParts } from "@/src/lib/message-utils"
import { resolveSlashAction } from "@/src/lib/slash-actions"
import { Hint } from "@/components/ui/hint"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function saveRecentFolders(folders: string[]) {
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
}

// First-time notice (workers): the settings modal only opens on the 1st
// activation of agent mode with no worker configured. "Use the main model"
// is a valid setting (fallback to the chat model) — after the
// notice, it does not open again, not even in a new chat (persisted).
const WORKER_CONFIG_PROMPTED_KEY = "orbit-worker-config-prompted"

function workerConfigPrompted() {
  return localStorage.getItem(WORKER_CONFIG_PROMPTED_KEY) === "1"
}

function markWorkerConfigPrompted() {
  localStorage.setItem(WORKER_CONFIG_PROMPTED_KEY, "1")
}

export function CodeInput({ onSubmit, status, onStop, hasMessages, sessionId, onProviderBlocked, showFolders = true, folders: foldersProp, onFoldersChange: onFoldersChangeProp }: {
  onSubmit: (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[], files?: FilePart[]) => void
  status?: ChatStatus
  onStop?: () => void
  hasMessages?: boolean
  /** Active session — the Brain toggle is per chat (undefined = new chat) */
  sessionId?: string
  /** No provider configured and the user tried to send — whoever renders the card decides how to react */
  onProviderBlocked?: () => void
  /** Shows the folders/repositories selector above the input (it goes away in views like the browser fullscreen) */
  showFolders?: boolean
  /** Folders of the chat when they are NOT the workspace ones (panel tab: the ones of its own session) */
  folders?: string[]
  onFoldersChange?: (folders: string[]) => void
}) {
  const { t } = useTranslation()
  // Key of the replied message: the code chat has no draft per
  // panel, so it is the session (or "draft" in the new chat).
  const replyKey = sessionId ?? "draft"
  // ↑/↓ bring back the texts already sent in this session.
  const navigateHistory = useInputHistory(sessionId, replyKey)
  const codeActiveModes = useModelModePrefs((s) => s.codeActiveModes)
  const plan = useModeActive("plan", sessionId, codeActiveModes.plan)
  const search = useModeActive("search", sessionId, codeActiveModes.search)
  const subagents = useModeActive("subagents", sessionId, codeActiveModes.subagents)
  // A worker (subchat of an orchestration) never orchestrates: that would be
  // recursion, and the engine already blocks it on the main side
  // (allowDelegation/orchestrate). The toggle leaves the UI so the state does not lie.
  const isWorker = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.orchestration?.role === "worker",
  )
  const orchestra =
    useModeActive("orchestra", sessionId, codeActiveModes.orchestra) && !isWorker
  const setModeActive = useModeOverrides((s) => s.setMode)
  const [loop, setLoop] = useState(false)
  const { mode } = useWorkspace()
  // Orchestration is exclusive to code mode, and never inside a worker
  useEffect(() => {
    if (mode === "chat" || isWorker) setModeActive("orchestra", sessionId, false)
  }, [mode, isWorker, sessionId, setModeActive])
  const [configKind, setConfigKind] = useState<DelegationConfigKind | null>(null)
  const [loopConfigOpen, setLoopConfigOpen] = useState(false)
  // The "+" menu is controlled so it can CLOSE when the gear opens one of the
  // settings modals: the menu popup lives at z-[999], above the modals
  // (z-[80]) on purpose, and the gear stops the click propagation — without
  // closing it by hand, it stays open over the form.
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const simple = useSimpleMode(sessionId, codeActiveModes.simple)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const brain = useBrainEnabled(sessionId, codeActiveModes.brain)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)
  const brainContext = useCodeContext()
  // Autonomy PER CHAT: the selector changes only this conversation.
  const permissionMode = usePermissionMode(sessionId)
  const setPermissionMode = useCallback(
    (id: PermissionMode) => usePermissionPrefs.getState().setMode(sessionId, id),
    [sessionId],
  )
  const { folders: foldersDoWorkspace, setFolders: setFoldersDoWorkspace } = useWorkspace()
  // A panel tab passes the folders of its own session; in the rest, the workspace
  // is the source (it is what the send writes to the session).
  const folders = foldersProp ?? foldersDoWorkspace
  const setFolders = onFoldersChangeProp ?? setFoldersDoWorkspace
  // Without a folder code mode has nowhere to work. Send is NOT
  // disabled because of that: the submit is intercepted (the text is preserved) and the
  // card below the selector says the reason, with the shortcut that solves it.
  const noFolder = folders.length === 0
  const [folderHintVisible, setFolderHintVisible] = useState(false)
  // The card is about the missing folder: it goes away by itself when one is attached.
  useEffect(() => {
    if (!noFolder) setFolderHintVisible(false)
  }, [noFolder])

  // Project skills (.orbit/skills) follow the active main folder
  useEffect(() => {
    void useSkillsStore.getState().refresh(folders[0])
  }, [folders])
  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const model = selected ? catalog[selected.providerId]?.models[selected.modelId] : undefined
  // Thinking PER CHAT: with no choice in this conversation, the model level applies.
  const { enabled, variantId: savedVariant, update } = useSessionReasoningPref(sessionId, selected?.providerId, selected?.modelId)
  const suggestion = usePromptSuggestion(sessionId)
  // A saved level this model does not offer (e.g. "medium" where there is only
  // low/high/max) becomes the nearest neighbor — the same one the engine sends.
  const variantId = closestVariant(model?.variants?.map((v) => v.id) ?? [], savedVariant) ?? savedVariant
  // Thinking: the preferences chip defines the default; the model's reasoning and
  // models with reasoningAlwaysOn keep applying as before
  const thinking = codeActiveModes.thinking || enabled || !!model?.reasoningAlwaysOn
  const busy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  // Pre-configuration (no provider): sending is blocked via onSubmitCapture —
  // in CAPTURE, before PromptInput's handleSubmit clears the input — so the
  // user's text is not lost; onProviderBlocked shows the explanatory card
  const noProvider = useNoProviderConnected()
  const openSettings = useSettingsUi((s) => s.openSettings)
  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const createSession = useSessionStore((s) => s.createSession)
  const openChatTab = usePanelStore((s) => s.openChatTab)
  const sessionDir = useSessionStore((s) => sessionId ? s.sessions.find(x => x.id === sessionId)?.directory : undefined)
  const visionModel = useProviderStore((s) => s.visionModel)
  const vision = useModeActive("vision", sessionId, codeActiveModes.vision)
  const computer = useComputerMode(sessionId)
  const setVisionConfigOpen = useProviderStore((s) => s.setVisionConfigOpen)
  const visionConfigOpen = useProviderStore((s) => s.visionConfigOpen)
  // MCP servers: a FIXED control in the footer, not a mode — it narrows which
  // servers this conversation sees (the tools themselves have no on/off).
  const toolsServers = useToolsServers(sessionId)
  const workerModel = useProviderStore((s) => s.workerModel)
  // First-time notice: it only opens on the 1st activation of agent mode with no worker
  // configured; after that the toggle only turns on/off (default = main model)
  const maybePromptWorkerConfig = useCallback((kind: DelegationConfigKind) => {
    if (workerModel || workerConfigPrompted()) return
    markWorkerConfigPrompted()
    setConfigKind(kind)
  }, [workerModel])
  const modesInRow = useAppearanceStore((s) => s.modesInRow)
  const modeLabelStyle = useAppearanceStore((s) => s.modeLabelStyle)
  const actionCommands = useSlashActionCommands("code")

  const buildOptions = useCallback((): SendMessageOptions => ({
    plan,
    research: search,
    simple,
    brain,
    brainContext: brainContext === "all" ? true : brainContext === "memory" ? brain : false,
    permissionMode,
    // Mode coming from the selector: switching in the middle of the reply counts right away.
    followGlobalPermission: true,
    reasoning: { enabled: thinking, variantId },
    subagents,
    orchestrate: orchestra && mode === "code" ? {} : undefined,
    // In the orchestra Loop does not apply (the reviewer is the orchestrator)
    loop: orchestra && mode === "code" ? undefined : loop,
    toolsServers: toolsServers ?? undefined,
    computer: computer.active || undefined,
  }), [plan, search, simple, brain, brainContext, permissionMode, thinking, variantId, subagents, orchestra, loop, toolsServers, mode, computer.active])

  const getDirs = useCallback(() => {
    const [directory, ...extraDirectories] = folders
    return { directory, extraDirectories }
  }, [folders])
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
      const { directory, extraDirectories } = getDirs()
      if (!directory) return false
      const options = { ...buildOptions(), voiceCall: true }
      const statusNow = useSessionStore.getState().status[targetSessionId]
      const busyNow = statusNow === "submitted" || statusNow === "streaming" || statusNow === "cancelling" || statusNow === "fallback"
      if (busyNow) {
        enqueueForSend(targetSessionId, text, options, "code", { directory, extraDirectories, files: [] })
        return true
      }
      void sendMessage("code", text, { options, sessionId: targetSessionId, directory, extraDirectories, files: [] })
      return true
    },
    [noProvider, onProviderBlocked, getDirs, buildOptions, enqueueForSend, sendMessage],
  )
  /** The call submit of THIS composer, tied to its session. */
  const submitVoiceToSession = useCallback(
    (text: string): boolean => (sessionId ? submitVoiceTo(sessionId, text) : false),
    [sessionId, submitVoiceTo],
  )
  /** New code chat: creates the session that owns the call before dialing. */
  const createCallSession = useCallback(async () => {
    if (folders.length === 0) return undefined
    const { directory, extraDirectories } = getDirs()
    const created = await createSession("code", { setActive: false, directory, extraDirectories })
    void useSessionStore.getState().selectSession("code", created.id)
    return {
      sessionId: created.id,
      submit: (text: string) => submitVoiceTo(created.id, text),
    }
  }, [folders.length, getDirs, createSession, submitVoiceTo])
  const voiceCall = useHostedVoiceCallControl({
    sessionId,
    mode: "code",
    submit: submitVoiceToSession,
    createCallSession,
  })
  // Same contract as the chat input: the call composer registers the current
  // submit, but the call stays tied to the session it was born in.
  const registerVoiceSubmit = voiceCall.registerSubmit
  useEffect(() => {
    if (voiceCall.call.active && voiceCall.isCallSession) registerVoiceSubmit(submitVoiceToSession)
  }, [voiceCall.call.active, voiceCall.isCallSession, registerVoiceSubmit, submitVoiceToSession])
  const selections = usePanelStore((s) => s.selections)
  const quotes = usePanelStore((s) => s.quotes)
  const removeQuote = usePanelStore((s) => s.removeQuote)
  const removeSelection = usePanelStore((s) => s.removeSelection)

  const modeToggleItems = useMemo<ModeToggleDef[]>(() => [
    { icon: Search, label: t("input.modes.search.label"), active: search, onChange: (v: boolean) => setModeActive("search", sessionId, v) },
    { icon: FileText, label: t("codeInput.modes.plan.label"), active: plan, onChange: (v: boolean) => setModeActive("plan", sessionId, v) },
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
  ], [search, plan, simple, brain, vision, visionModel, computer.visible, computer.active, sessionId, setBrainEnabled, setSimple, setModeActive, setVisionConfigOpen, t])

  const handleSubmit = useCallback((message: { text?: string; files?: { mediaType?: string; filename?: string; url?: string }[] }) => {
    // Editing a queue item (pencil in the queue): Enter saves the edit in the
    // SAME item — the queue order does not change — instead of queueing another.
    // With the input empty Enter cancels the edit and the normal flow goes on.
    const editingId = sessionId ? useMessageQueueStore.getState().editing[sessionId] : undefined
    const rawText = message.text?.trim()
    if (editingId && sessionId) {
      if (rawText) {
        const resolved = resolveSlashAction(rawText, "code")
        useMessageQueueStore.getState().update(sessionId, editingId, resolved?.prompt ?? rawText)
        useMessageQueueStore.getState().cancelEdit(sessionId)
        clearInputDraft(sessionId)
        return
      }
      useMessageQueueStore.getState().cancelEdit(sessionId)
    }
    const files = toFileParts(message.files ?? [])
    const resolved = message.text ? resolveSlashAction(message.text, "code") : null
    if (resolved?.action.kind === "init" && !busy) {
      const dir = folders[0]
      if (dir) {
        const force = resolved.input.includes("--force") || resolved.action.command === "/init-force"
        createSession("code", { directory: dir, extraDirectories: folders.slice(1) }).then((session) => {
          const text = force ? "/init --force" : "/init"
          sendMessage("code", text, { options: { initMode: true }, sessionId: session.id, directory: dir, extraDirectories: folders.slice(1) })
        })
      }
      return
    }
    const resolveText = (raw: string) => {
      const r = resolveSlashAction(raw, "code")
      return r?.prompt ?? raw
    }
    if (busy) {
      const text = message.text?.trim()
      if (!text) {
        onStop?.()
      } else if (sessionId && folders.length > 0) {
        const { directory, extraDirectories } = getDirs()
        enqueueForSend(sessionId, withReplyPrefix(replyKey, resolveText(text)), buildOptions(), mode, { directory, extraDirectories, files })
        clearInputDraft(sessionId)
      }
      return
    }
    let text = message.text?.trim()
    if (!text || folders.length === 0) return
    text = resolveText(text)
    saveRecentFolders(folders)
    const [directory, ...extraDirectories] = folders
    // Elements selected in the panel browser (selection mode): they become
    // attachments (chip/badge in the message bubble, like PDFs). The detail
    // (selector/html/text) goes serialized in the data URL of the marker MIME and the
    // engine converts it into text for the model — the bubble shows only the chip.
    const currentSelections = selections
    if (currentSelections.length > 0) {
      files.push(
        ...currentSelections.map<FilePart>((sel) => {
          const payload = encodeURIComponent(
            JSON.stringify({
              tag: sel.tag,
              url: sel.url,
              selector: sel.selector,
              text: sel.text,
              html: sel.html,
            }),
          )
          const label = sel.text ? `"${sel.text.slice(0, 40)}${sel.text.length > 40 ? "…" : ""}"` : ""
          return {
            id: sel.id,
            type: "file",
            mime: BROWSER_SELECTION_MIME,
            filename: `<${sel.tag}>${label ? ` ${label}` : ""}`,
            url: `data:${BROWSER_SELECTION_MIME},${payload}`,
          }
        }),
      )
      usePanelStore.getState().clearSelections()
    }
    if (quotes.length > 0) {
      files.push(...quotesToFileParts(quotes))
      usePanelStore.getState().clearQuotes()
    }
    // The message was sent: the session draft (if it existed from a previous
    // switch) can no longer come back to the input when reopening the chat.
    if (sessionId) clearInputDraft(sessionId)
    // The quote is prepended AFTER the "/" command is resolved (see chat-input)
    return onSubmit(
      withReplyPrefix(replyKey, text),
      buildOptions(),
      directory,
      extraDirectories,
      files.length > 0 ? files : undefined,
    )
  }, [busy, folders, sessionId, replyKey, onStop, selections, quotes, getDirs, buildOptions, onSubmit, mode, enqueueForSend, sendMessage, createSession])

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText("")
    }
    const permission = (id: PermissionMode, label: string, description: string): SlashCommand => ({
      id: `perm-${id}`,
      label: t("codeInput.slash.permissionLabel", { label }),
      description,
      keywords: ["permission", "autonomy", id],
      group: "Modes",
      active: permissionMode === id,
      run: toggle(() => setPermissionMode(id)),
    })
    return [
      { id: "search", label: t("input.modes.search.label"), description: t("codeInput.slash.searchDescription"), keywords: ["web", "search"], group: "Modes" as const, active: search, run: toggle(() => setModeActive("search", sessionId, !search)) },
      { id: "plan", label: t("codeInput.modes.plan.label"), description: t("codeInput.slash.planDescription"), keywords: ["plan", "reading"], group: "Modes" as const, active: plan, run: toggle(() => setModeActive("plan", sessionId, !plan)) },
      { id: "plain", label: t("input.modes.simple.label"), description: t("input.slash.simpleDescription"), keywords: ["plain", "text"], group: "Modes" as const, active: simple, run: toggle(() => setSimple(sessionId, !simple)) },
      { id: "brain", label: t("input.slash.brainLabel"), description: t("codeInput.slash.brainDescription"), keywords: ["memory", "brain"], group: "Modes" as const, active: brain, run: toggle(() => setBrainEnabled(sessionId, !brain)) },
      { id: "subagents", label: t("codeInput.slash.subagentsLabel"), description: t("codeInput.slash.subagentsDescription"), keywords: ["worker", "delegate"], group: "Modes" as const, active: subagents, run: toggle(() => {
        setModeActive("subagents", sessionId, !subagents)
        if (!subagents) maybePromptWorkerConfig("subagents")
      }) },
      ...(mode === "code" && !isWorker ? [{ id: "orchestra", label: t("codeInput.slash.orchestraLabel"), description: t("codeInput.slash.orchestraDescription"), keywords: ["workers", "plan"], group: "Modes" as const, active: orchestra, run: toggle(() => {
        setModeActive("orchestra", sessionId, !orchestra)
        if (!orchestra) {
          setLoop(false)
          maybePromptWorkerConfig("orchestra")
        }
      }) }] : []),
      permission("ask", t("codeInput.slash.permAsk"), t("codeInput.slash.permAskDescription")),
      permission("approve", t("codeInput.slash.permApprove"), t("codeInput.slash.permApproveDescription")),
      permission("full", t("codeInput.slash.permFull"), t("codeInput.slash.permFullDescription")),
      // Loop: in the orchestra the reviewer is the orchestrator — the item shows
      // up but disabled (same rule as the chip on the input row).
      { id: "loop", label: t("codeInput.modes.loop.label"), description: orchestra ? t("delegation.loopOffInOrchestra") : t("codeInput.modes.loop.description"), keywords: ["loop", "iterate", "review"], group: "Modes" as const, active: loop && !orchestra, disabled: orchestra, run: toggle(() => setLoop((v) => !v)) },
      // Vision: first activation with no model configured opens the settings.
      { id: "vision", label: t("input.modes.vision.label"), description: t("input.modes.vision.description"), keywords: ["vision", "image"], group: "Modes" as const, active: vision, run: toggle(() => {
        if (!vision && !visionModel) setVisionConfigOpen(true)
        else setModeActive("vision", sessionId, !vision)
      }) },
      ...actionCommands,
      { id: "new-session", label: t("codeInput.slash.newSession"), description: t("codeInput.slash.newSessionDescription"), keywords: ["clear", "reset", "new"], group: "Actions" as const, run: toggle(() => void useSessionStore.getState().selectSession(mode, null)) },
      // Palette rule: what WRITES text into the input appears with the literal
      // text (what will be sent); what only acts on the UI (modes, new session,
      // settings) appears with a prose label. Thus "/init" and "/document" are
      // the same as what the user types, and nothing lies about what is going to be
      // sent. The REFERENCES (skills, MCP, files) stay in the "@" palette.
      { id: "create-skill", label: "/create-skill", description: t("codeInput.slash.createSkillDescription"), keywords: ["skill", "create", "learn"], group: "Actions" as const, run: ({ setText }) => setText("/create-skill ") },
      { id: "document", label: "/document", description: t("codeInput.slash.documentAppDescription"), keywords: ["docs", "documentation", "screenshot"], group: "Actions" as const, run: ({ setText }) => setText("/document ") },
      { id: "settings", label: t("input.slash.settings"), description: t("input.slash.settingsDescription"), keywords: ["settings", "config"], group: "Actions" as const, run: toggle(() => openSettings()) },
    ]
  }, [search, plan, simple, brain, subagents, orchestra, isWorker, permissionMode, sessionId, setBrainEnabled, setSimple, setModeActive, setPermissionMode, actionCommands, mode, openSettings, maybePromptWorkerConfig, loop, vision, visionModel, setVisionConfigOpen, t])

  return (
    <PromptInputProvider>
      <ReferencePalette directory={sessionDir ?? folders[0]} servers={toolsServers} className="mx-auto w-full max-w-2xl">
      <SlashPalette commands={slashCommands} className="mx-auto w-full max-w-2xl">
      <DraftInputBridge sessionId={sessionId} />
      <ChatInputDraft sessionId={sessionId} />
      <PendingAttachmentSync sessionId={sessionId} />
      <div className="w-full max-w-2xl mx-auto pb-4 @container">
        {!hasMessages && showFolders && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
            <FolderSelector folders={folders} onFoldersChange={setFolders} pulse={noFolder} />
          </div>
        )}
        <FolderHintCard
          visible={folderHintVisible}
          onPick={(folder) => {
            saveRecentFolders([folder])
            setFolders([folder])
          }}
          onDismiss={() => setFolderHintVisible(false)}
        />
        <PromptInputAttachments className="!w-auto !p-0 mb-2" leading={<ReplyBar replyKey={replyKey} />}>
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        {/* Excerpts quoted from the document viewer and instants pointed at
            in the Motion tab */}
        {quotes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
            {quotes.map((q) => (
              <span
                key={q.id}
                title={quoteChipTitle(q)}
                className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
              >
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
        {/* Elements selected in the panel browser (selection mode) */}
        {selections.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
            {selections.map((sel) => (
              <span
                key={sel.id}
                title={`${sel.selector}\n"${sel.text}"`}
                className="flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400"
              >
                <MousePointerClick className="size-3" />
                {"<"}{sel.tag}{">"} {sel.text ? `"${sel.text.slice(0, 24)}${sel.text.length > 24 ? "…" : ""}"` : t("codeInput.selected")}
                <Hint label={t("common.remove")}>
                  <button
                    type="button"
                    onClick={() => removeSelection(sel.id)}
                    className="ml-0.5 rounded-sm hover:bg-emerald-500/20"
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
          onSubmitCapture={(e) => {
            // In CAPTURE, before PromptInput's handleSubmit clears the
            // input: the user's text stays where it is and the card says the reason,
            // instead of the click dying in silence (no provider or no
            // folder). The provider card has precedence — without it nothing else
            // would work anyway.
            if (noProvider) {
              e.preventDefault()
              e.stopPropagation()
              onProviderBlocked?.()
              return
            }
            if (noFolder) {
              e.preventDefault()
              e.stopPropagation()
              setFolderHintVisible(true)
            }
          }}
          onSubmit={handleSubmit}
          className="relative rounded-xl border-2 border-sidebar-border [&>div]:!rounded-[calc(var(--radius-xl)-2px)] [&>div]:!border-none [&>div]:!bg-transparent"
        >
          <PromptInputBody>
            {/* The microphone is anchored to the LINE of the textarea, and not to the top of the
                box — the same position as the chat input. */}
            <div className="relative w-full">
              {/* TOP right corner, at the level of the first line of the text —
                  the same position as the chat input: absolute so it does not push the
                  content, with the slack on the right reserved in the textarea itself
                  (pr-10). */}
              <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5">
                <VoiceCallPanel control={voiceCall} />
                <DictationButton sessionId={sessionId} />
              </div>
              <PromptInputTextarea
                placeholder={folders.length === 0 ? t("codeInput.placeholderNoFolder") : t("codeInput.placeholder")}
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
                  <DelegationMenuItems
                    subagents={subagents}
                    orchestra={orchestra}
                    loop={loop}
                    onSubagentsChange={(v) => {
                      setModeActive("subagents", sessionId, v)
                      if (v) {
                        setModeActive("orchestra", sessionId, false)
                        // First-time notice (only on the 1st activation with no worker)
                        maybePromptWorkerConfig("subagents")
                      }
                    }}
                    onOrchestraChange={(v) => {
                      setModeActive("orchestra", sessionId, v)
                      if (v) {
                        setModeActive("subagents", sessionId, false)
                        setLoop(false)
                        // First-time notice (only on the 1st activation with no worker)
                        maybePromptWorkerConfig("orchestra")
                      }
                    }}
                    onLoopChange={setLoop}
                    onOpenConfig={(kind) => {
                      // Closes the "+" before opening the modal (see the comment of the
                      // state): the menu popup would cover the form.
                      setAddMenuOpen(false)
                      setConfigKind(kind)
                    }}
                    onOpenLoopConfig={() => {
                      setAddMenuOpen(false)
                      setLoopConfigOpen(true)
                    }}
                    mode={mode}
                  />
                  <DropdownMenuSeparator />
                  <PromptInputActionAddAttachments label={t("input.attachFiles")} />
                </DropdownMenuContent>
              </DropdownMenu>
              <QuickSettingsMenu sessionId={sessionId} showPermission />
              <div className="hidden @md:block">
                <PermissionModePicker sessionId={sessionId} />
              </div>
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
                emptySlot={voiceCall.inSlot ? <VoiceCallButton control={voiceCall} /> : undefined}
                emptySlotAlways={voiceCall.call.active && voiceCall.isCallSession}
                busy={busy}
                cancelling={status === "cancelling"}
                // Without a folder Send stays active on purpose (the submit is
                // intercepted and the card explains). The chevron does NOT stay
                // disabled — it is the same visual piece as Send and would end up with
                // two opacities; it also lights up the card, instead of opening an
                // actions menu that would schedule without a directory.
                onOptionsBlocked={noFolder ? () => setFolderHintVisible(true) : undefined}
                onStop={() => onStop?.()}
                onQueue={(text, files) => {
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueForSend(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, { directory, extraDirectories, files: toFileParts(files ?? []) })
                }}
                onStopAndSend={(text, files) => {
                  onStop?.()
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueForSend(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, { directory, extraDirectories, files: toFileParts(files ?? []) })
                }}
                onSchedule={(text, timestamp, files) => {
                  if (!sessionId) return
                  const { directory, extraDirectories } = getDirs()
                  enqueueScheduled(sessionId, withReplyPrefix(replyKey, text), buildOptions(), mode, timestamp, { directory, extraDirectories, files: toFileParts(files ?? []) })
                }}
                onSendToSidePanel={async (text, files) => {
                  const { directory, extraDirectories } = getDirs()
                  // New chat in the same folder as the current session (if it is in one)
                  const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                  const newSession = await createSession(mode, { setActive: false, directory, extraDirectories, folderId: current?.folderId ?? null })
                  await sendMessage(mode, withReplyPrefix(replyKey, text), { options: buildOptions(), sessionId: newSession.id, directory, extraDirectories, files: toFileParts(files ?? []) })
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
              description={t("codeInput.modes.search.description")}
              active={search}
              onToggle={() => setModeActive("search", sessionId, !search)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("plan") && (
            <ModeToggle
              icon={FileText}
              label={t("codeInput.modes.plan.label")}
              description={t("codeInput.modes.plan.description")}
              active={plan}
              onToggle={() => setModeActive("plan", sessionId, !plan)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("simple") && (
            <ModeToggle
              icon={AlignLeft}
              label={t("input.modes.simple.label")}
              description={t("codeInput.modes.simple.description")}
              active={simple}
              onToggle={() => setSimple(sessionId, !simple)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("brain") && (
            <ModeToggle
              icon={BrainCircuit}
              label={t("input.modes.brain.label")}
              description={t("codeInput.modes.brain.description")}
              active={brain}
              onToggle={() => setBrainEnabled(sessionId, !brain)}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("subagents") && (
            <ModeToggle
              icon={Bot}
              label={t("codeInput.modes.subagents.label")}
              description={t("codeInput.modes.subagents.description")}
              active={subagents}
              onToggle={() => {
                const next = !subagents
                setModeActive("subagents", sessionId, next)
                if (next) {
                  setModeActive("orchestra", sessionId, false)
                  // First-time notice (only on the 1st activation with no worker)
                  maybePromptWorkerConfig("subagents")
                }
              }}
              onConfig={() => setConfigKind("subagents")}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {mode === "code" && !isWorker && modesInRow.includes("orchestra") && (
            <ModeToggle
              icon={Network}
              label={t("codeInput.modes.orchestra.label")}
              description={t("codeInput.modes.orchestra.description")}
              active={orchestra}
              onToggle={() => {
                const next = !orchestra
                setModeActive("orchestra", sessionId, next)
                if (next) {
                  setModeActive("subagents", sessionId, false)
                  setLoop(false)
                  // First-time notice (only on the 1st activation with no worker)
                  maybePromptWorkerConfig("orchestra")
                }
              }}
              onConfig={() => setConfigKind("orchestra")}
              iconOnly={modeLabelStyle === "icon"}
            />
          )}
          {modesInRow.includes("loop") && (
            <ModeToggle
              icon={RefreshCw}
              label={t("codeInput.modes.loop.label")}
              description={orchestra ? t("delegation.loopOffInOrchestra") : t("codeInput.modes.loop.description")}
              active={loop && !orchestra}
              disabled={orchestra}
              onToggle={() => setLoop((v) => !v)}
              onConfig={() => setLoopConfigOpen(true)}
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
        <OrchestrationConfigDialog kind={configKind} onOpenChange={(open) => { if (!open) setConfigKind(null) }} />
        <LoopConfigDialog open={loopConfigOpen} onOpenChange={setLoopConfigOpen} />
        <VisionConfigDialog open={visionConfigOpen} onOpenChange={setVisionConfigOpen} targetSession={sessionId} />
      </div>
      </SlashPalette>
      </ReferencePalette>
    </PromptInputProvider>
  )
}
