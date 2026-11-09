import { useState, useRef, useCallback, useEffect, memo, useMemo, type ReactNode } from 'react'
import { View, TextInput, Text, ActivityIndicator, Platform, TouchableOpacity, Keyboard } from 'react-native'
import { Plus, Mic, X, AudioLines } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import type { SendMessageOptions, FilePart, SessionInfo } from '@orbit/shared'
import { resolveSlashAction } from '@orbit/shared'
import { AttachmentSheet, type ModeItem, type ToolItem } from './AttachmentSheet'
import { useSessionTools, useToolsServers } from '~/stores/session-tools'
import { useToolsStore } from '~/stores/tools-store'
import { WorkerModelModal } from './WorkerModelModal'
import { VisionConfigModal } from './VisionConfigModal'
import { LoopConfigModal } from './LoopConfigModal'
import { InputAttachment } from './Attachment'
import { SlashPalette } from './SlashPalette'
import { useSlashCommands, useReferenceCommands } from '~/hooks/useSlashCommands'
import { useDictation } from '~/hooks/useDictation'
import { useChatModes } from '~/hooks/useChatModes'
import { useSessionModelLabel } from '~/hooks/useSessionModelLabel'
import { uriToFilePart } from '~/lib/attachments'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useSessionReasoningPref } from '~/stores/session-reasoning'
import { usePermissionMode, usePermissionPrefs } from '~/stores/permission-prefs'
import { useModelModePrefs } from '~/stores/model-mode-prefs'
import { useModeOverrides } from '~/stores/mode-overrides'
import { useLoopPrefs } from '~/stores/loop-prefs'
import { Storage } from '~/lib/storage'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useBottomBreathing } from '~/lib/keyboard'
import { useThemeStore } from '~/stores/theme-store'
import { SendButtonGroup } from './SendButtonGroup'
import { QueueIndicator } from './QueueIndicator'
import { ScheduleSheet } from './ScheduleSheet'
import { useMessageQueueStore } from '~/stores/message-queue-store'
import { sessionModelFor, useSessionStore, useSessionModel } from '~/stores/session-store'
import { useDraftInput } from '~/stores/draft-input-store'
import { setInputDraft, getInputDraft, hydrateInputDrafts } from '~/stores/chat-draft-store'
import { ReplyBar } from '~/components/chat/ReplyBar'
import { withReplyPrefix } from '~/stores/reply-store'

interface PromptInputProps {
  onSend: (text: string, options: SendMessageOptions, files?: FilePart[]) => void
  onAbort: () => void
  isStreaming?: boolean
  sessionId?: string
  disabled?: boolean
  /** Blocks only the send (the text stays editable) — e.g. code mode without
   *  an associated folder. */
  sendDisabled?: boolean
  onCreateSession?: () => Promise<SessionInfo | null>
  onNavigateToSession?: (sessionId: string) => void
  /** Code mode: folders of the chat (main first) — the "Folder & branch" page. */
  folders?: string[]
  onFoldersChange?: (folders: string[]) => void
  /** Bumped when the header strip asks the "+" sheet to open on the folder page. */
  foldersRequest?: number
}

async function fileToFilePart(asset: any): Promise<FilePart> {
  return uriToFilePart(asset.uri, asset.mimeType, asset.name)
}

// First-time notice (workers): the modal only opens on the 1st activation of agent mode
// without a configured worker; "use the same model as the chat" is valid (persisted)
const WORKER_CONFIG_PROMPTED_KEY = 'orbit_worker_config_prompted'

/** Line height of the field (text-base = 16/24, set explicitly). */
const INPUT_LINE_HEIGHT = 24

/**
 * The field grows with its content up to 10 lines; past that the height is fixed and the
 * text scrolls inside it — multiline + maxHeight does both, natively.
 */
const INPUT_MAX_LINES = 10
/**
 * Vertical padding, held by the WRAPPER around the field rather than by the field itself.
 * The field then measures exactly one lineHeight per line, so at one line the wrapper is
 * the same height as the buttons and the row's bottom alignment centres the icons on the
 * text; as the field grows the buttons stay anchored to the bottom of the card.
 */
const INPUT_VERTICAL_PADDING = 8

/** Side of the round action buttons (+ / mic / send). The field's resting height matches it. */
const ACTION_SIZE = 40

export function PromptInput({
  onSend,
  onAbort,
  isStreaming,
  sessionId,
  disabled,
  sendDisabled,
  onCreateSession,
  onNavigateToSession,
  folders,
  onFoldersChange,
  foldersRequest,
}: PromptInputProps) {
  const { t } = useTranslation()
  const workspaceMode = useWorkspaceStore((s) => s.mode)
  const modeDefaults = useModelModePrefs((s) =>
    workspaceMode === 'code' ? s.codeActiveModes : s.chatActiveModes,
  )

  const [text, setText] = useState('')
  const prevSessionIdRef = useRef(sessionId)
  const textRef = useRef(text)
  // Last text loaded/persisted for the current session: the persist effect
  // compares against it so as not to write '' over a freshly loaded draft
  // nor rewrite the same text on every keystroke.
  const loadedDraftRef = useRef('')
  // true when the current text came from draft-input (revert/adoption): the load of the
  // persisted draft, which resolves later (async), must not overwrite it.
  const consumedRef = useRef(false)
  // Synchronized in an effect, not in the render body: writing to a ref during
  // render is exactly what the react-hooks/refs rule forbids. The only reader
  // is the session-switch effect below, which runs after this one.
  // It also persists the per-chat draft while the user types (debounce in the
  // store): leaving the app in the middle of typing does not lose the text.
  useEffect(() => {
    textRef.current = text
    if (text === loadedDraftRef.current) return
    loadedDraftRef.current = text
    setInputDraft(sessionId ?? 'draft', text)
  }, [text, sessionId])

  // Plan accepted → turns off the plan mode toggle: the next message must
  // not generate another plan.
  const planReview = useSessionStore((s) => (sessionId ? s.planReviews[sessionId] : undefined))

  const setModeActive = useModeOverrides((s) => s.setMode)
  useEffect(() => {
    if (planReview?.status === 'implementing') setModeActive('plan', sessionId, false)
  }, [planReview, sessionId, setModeActive])

  // Restores the input text on mount/chat switch (per-chat draft,
  // persisted on the device — survives an app restart).
  useEffect(() => {
    let cancelled = false
    const key = sessionId ?? 'draft'
    const prev = prevSessionIdRef.current
    if (prev !== sessionId) {
      if (prev) setInputDraft(prev, textRef.current)
      consumedRef.current = false
      prevSessionIdRef.current = sessionId
    }
    void hydrateInputDrafts().then(() => {
      if (cancelled) return
      // A revert handed back to the input (draft-input-store) takes precedence over
      // the persisted draft: the consume runs in the effect below, before this
      // callback (the hydration is asynchronous).
      if (consumedRef.current) return
      const saved = getInputDraft(key)
      loadedDraftRef.current = saved
      // '' also restores: without a draft, it clears the text left by the previous
      // session (PromptInput does not remount on every session switch).
      setText(saved)
    })
    return () => { cancelled = true }
  }, [sessionId])
  const [attachments, setAttachments] = useState<FilePart[]>([])

  const clearText = useCallback(() => {
    setText('')
  }, [])

  const [plusOpen, setPlusOpen] = useState(false)
  const [workerConfigOpen, setWorkerConfigOpen] = useState(false)
  const [loopConfigOpen, setLoopConfigOpen] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  // Small lift applied to the action buttons so their centre matches the text centre. The
  // native field ends up a few px taller than one lineHeight, so a bottom-anchored button
  // sits below the text; measuring the resting height lets us lift it by exactly half the
  // excess instead of guessing a fixed offset. Zero when field and buttons already match.
  const [actionLift, setActionLift] = useState(0)
  const oneLineFieldHeightRef = useRef(0)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  // FIXED padding: the KeyboardAvoidingView discounts this same value from the keyboard
  // height (negative keyboardVerticalOffset, in ChatScreen), so there is a single
  // animation and the input does not go out of phase with the keyboard. See lib/keyboard.
  const closedBreath = useBottomBreathing()
  // Autonomy PER CHAT (parity with the desktop): the selector changes only this
  // conversation; in a new chat the choice becomes the default of the next one.
  const permissionMode = usePermissionMode(sessionId)
  const setPermissionMode = usePermissionPrefs((s) => s.setMode)
  const [scheduleSheetVisible, setScheduleSheetVisible] = useState(false)
  // The folder strip of the header asks the "+" sheet to open on the folder page.
  const [startOnFolders, setStartOnFolders] = useState(false)
  useEffect(() => {
    if (!foldersRequest) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStartOnFolders(true)
    setPlusOpen(true)
  }, [foldersRequest])

  const catalog = useSettingsStore((s) => s.catalog)
  // EFFECTIVE model of the session (per-chat override > draft > global default) —
  // parity with the desktop (chat-input), where thinking follows the model of the
  // open chat, not the global default of the app.
  const selected = useSessionModel(sessionId)
  const model = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]
    : undefined
  // Thinking PER CHAT: without a choice in this conversation, the level of the model applies.
  const { enabled, variantId, isExplicit, update, hydrate, hydrated } = useSessionReasoningPref(sessionId, selected?.providerId, selected?.modelId)
  // Thinking: the default of the preferences defines the default; reasoning of the model
  // and models with reasoningAlwaysOn keep applying as before
  // An explicit choice in this chat wins over the model default — that is what makes
  // "Off" in the sheet actually turn it off when the preference is on.
  const thinking = model?.reasoningAlwaysOn
    ? true
    : isExplicit
      ? enabled
      : modeDefaults.thinking
  const visionConfigOpen = useSettingsStore((s) => s.visionConfigOpen)
  const setVisionConfigOpen = useSettingsStore((s) => s.setVisionConfigOpen)

  useEffect(() => {
    if (!hydrated) hydrate()
  }, [hydrated, hydrate])

  // Subscribes to the draft (not only reads it on session switch): the revert gives the message
  // back to the input while in the same session, and a consume only on [sessionId] would miss it.
  const pendingDraft = useDraftInput((s) => s.drafts[sessionId ?? 'draft'])
  useEffect(() => {
    if (pendingDraft === undefined) return
    const payload = useDraftInput.getState().consume(sessionId)
    if (!payload) return
    // Marks it before setText: the load of the persisted draft (effect above)
    // resolves later and must not overwrite the text given back by the revert.
    consumedRef.current = true
    // Fetching/syncing data in an effect is the documented React pattern;
    // the setState the rule flags is the loading/reset marker that
    // MUST happen before the await, otherwise the screen shows stale data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(payload.text)
    if (payload.files?.length) setAttachments((prev) => [...prev, ...payload.files!])
  }, [pendingDraft, sessionId])

  const inputRef = useRef<TextInput>(null)

  // Workers: first-time notice — it only opens on the 1st activation without a configured
  // worker ("use the same model" is valid); after that, never again.
  const [workerConfigPrompted, setWorkerConfigPrompted] = useState(false)

  // Configuration gates: turning a mode on can require its own setup (a vision model,
  // a worker model). They are the only part of the toggle that needs the modals of this
  // component — the state of the modes lives in the hook, shared with the header.
  const modeGates = useMemo(() => ({
    onVisionNeedsConfig: () => setVisionConfigOpen(true),
    onWorkerNeedsConfig: () => {
      if (workerConfigPrompted) return
      setWorkerConfigPrompted(true)
      Storage.setItem(WORKER_CONFIG_PROMPTED_KEY, '1').catch(() => {})
      setWorkerConfigOpen(true)
    },
  }), [workerConfigPrompted, setVisionConfigOpen])

  const { modes, states } = useChatModes(sessionId, modeGates)

  // MCP servers of this chat: as on the desktop, the tools exist while a server is
  // enabled in the app — here we choose only WHICH ones enter the context.
  const mcpServers = useToolsStore((s) => s.mcpServers)
  const toolsSelection = useToolsServers(sessionId)
  const setToolServers = useSessionTools((s) => s.setServers)

  useEffect(() => {
    if (!useSessionTools.getState().hydrated) void useSessionTools.getState().hydrate()
  }, [])

  const availableTools = useMemo(
    () => mcpServers.filter((server) => server.config.enabled !== false),
    [mcpServers],
  )
  const selectedTools = useMemo(
    () => toolsSelection ?? availableTools.map((server) => server.config.name),
    [toolsSelection, availableTools],
  )
  const sheetTools = useMemo<ToolItem[]>(
    () =>
      availableTools.map((server) => ({
        name: server.config.name,
        active: selectedTools.includes(server.config.name),
        connected: server.state === 'connected',
      })),
    [availableTools, selectedTools],
  )
  const handleToolToggle = useCallback(
    (name: string) => {
      const next = selectedTools.includes(name)
        ? selectedTools.filter((item) => item !== name)
        : [...selectedTools, name]
      // Selecting every server again goes back to "all": the choice then follows a new one.
      setToolServers(sessionId, next.length === availableTools.length ? null : next)
    },
    [selectedTools, availableTools.length, setToolServers, sessionId],
  )
  const { search, browser, simple, brain, plan: planMode, subagents, orchestra } = states
  const loop = useLoopPrefs((s) => s.enabled)
  const modelLabel = useSessionModelLabel(sessionId)

  // The sheet lists every mode; the ones with their own setup get the gear when active.
  const sheetModes = useMemo<ModeItem[]>(() => modes.map((mode) => ({
    ...mode,
    onConfigure:
      mode.id === 'vision'
        ? () => { setPlusOpen(false); setVisionConfigOpen(true) }
        : mode.id === 'subagents' || mode.id === 'orchestra'
          ? () => { setPlusOpen(false); setWorkerConfigOpen(true) }
          : mode.id === 'loop'
            ? () => { setPlusOpen(false); setLoopConfigOpen(true) }
            : undefined,
  })), [modes, setVisionConfigOpen])

  useEffect(() => {
    // Mounts with the chat and can be gone before the storage answers (the app opens on
    // the new chat and replaces it), so the continuation checks that it is still alive.
    let cancelled = false
    Storage.getItem(WORKER_CONFIG_PROMPTED_KEY)
      .then((v) => { if (!cancelled && v === '1') setWorkerConfigPrompted(true) })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handlePickFiles = async () => {
    setPlusOpen(false)
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: true,
      })

      if (!result.canceled && result.assets) {
        const parts = await Promise.all(
          result.assets.map((asset) => fileToFilePart(asset))
        )
        setAttachments((prev) => [...prev, ...parts])
      }
    } catch (err) {
      console.error('Failed to pick files:', err)
    }
  }

  const handleTakePhoto = async () => {
    setPlusOpen(false)
    try {
      // `ImagePicker` comes from the top of the file, not from a lazy `import()` here:
      // a dynamic import resolves by the module id of the running bundle, and after a
      // Fast Refresh that id is stale — that is the "Requiring unknown module" that
      // showed up when opening the camera, followed by "undefined is not a function"
      // because the module came back without its exports.
      const perm = await ImagePicker.requestCameraPermissionsAsync()
      if (!perm.granted) return
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 })
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0]
        const part = await uriToFilePart(asset.uri, asset.mimeType ?? 'image/jpeg', asset.fileName ?? undefined)
        setAttachments((prev) => [...prev, part])
      }
    } catch (err) {
      console.error('Failed to take photo:', err)
    }
  }

  const handlePickPhotos = async () => {
    setPlusOpen(false)
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) return
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, allowsMultipleSelection: true })
      if (!result.canceled && result.assets) {
        const parts = await Promise.all(
          result.assets.map((asset) =>
            uriToFilePart(asset.uri, asset.mimeType ?? 'image/jpeg', asset.fileName ?? undefined),
          ),
        )
        setAttachments((prev) => [...prev, ...parts])
      }
    } catch (err) {
      console.error('Failed to pick photos:', err)
    }
  }

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id))
  }

  const buildOptions = useCallback((live = false) => {
    const modeNow = useWorkspaceStore.getState().mode
    return {
      research: search,
      browser,
      simple,
      brain,
      reasoning: { enabled: thinking, variantId },
      plan: modeNow === 'code' ? planMode : undefined,
      subagents,
      orchestrate: orchestra && modeNow === 'code' ? {} : undefined,
      loop,
      permissionMode: modeNow === 'code' ? permissionMode : undefined,
      // Mode coming from the selector: on the desktop it applies already to the next tool of the
      // answer in progress. Now the main resolves by the level of THIS chat, so the
      // same contract applies here without leaking to the others.
      // Slice of MCP servers of this chat — absent = every server enabled in the app.
      toolsServers: toolsSelection ?? undefined,
      followGlobalPermission: modeNow === 'code' ? true : undefined,
      // Live call: the answer should be SPEAKABLE (the desktop reads it aloud in a call).
      ...(live ? { voiceCall: true } : {}),
    } satisfies SendMessageOptions
  }, [search, browser, simple, brain, thinking, variantId, planMode, subagents, orchestra, loop, permissionMode, toolsSelection])

  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)

  const queueText = useCallback((trimmed: string, live = false) => {
    if (!sessionId) return
    const modeNow = useWorkspaceStore.getState().mode
    const resolved = resolveSlashAction(trimmed, modeNow)
    // The quote comes in AFTER the "/" command is resolved: in front of it, the
    // text would stop starting with "/" and the command would become conversation.
    // The model of the chat goes WITH the item: the desktop delivers the queue, and a
    // chat born on the phone has no per-chat model there.
    const model = sessionModelFor(sessionId)
    enqueueForSend(sessionId, withReplyPrefix(sessionId, resolved?.prompt ?? trimmed), buildOptions(live), modeNow, {
      files: attachments.length > 0 ? attachments : undefined,
      providerId: model?.providerId,
      modelId: model?.modelId,
    })
    clearText()
    setAttachments([])
  }, [sessionId, enqueueForSend, buildOptions, attachments, clearText])

  const handleQueue = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    queueText(trimmed)
  }, [text, queueText])

  const handleStopAndSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId) return
    onAbort()
    queueText(trimmed)
  }, [text, sessionId, onAbort, queueText])

  /**
   * The only path that actually sends: the text may come from the field (send button) or
   * from the dictation of a live call, which arrives ready to go.
   */
  const submitText = useCallback((raw: string, live = false) => {
    const trimmed = raw.trim()
    if (!trimmed || disabled || sendDisabled) return

    // Agent running: instead of blocking the send (it made the text get stuck
    // in the input when pressing Enter), it sends to the session queue — the same
    // "send to the side panel" of the desktop — and clears the input so the
    // user can keep typing while the agent works.
    if (isStreaming) {
      if (sessionId) {
        queueText(trimmed, live)
      } else {
        clearText()
        setAttachments([])
      }
      return
    }

    const modeNow = useWorkspaceStore.getState().mode
    const options: SendMessageOptions = buildOptions(live)

    // "/" commands become the prompt of the corresponding pipeline
    const resolved = resolveSlashAction(trimmed, modeNow)
    const finalText = withReplyPrefix(sessionId, resolved?.prompt ?? trimmed)

    onSend(finalText, options, attachments.length > 0 ? attachments : undefined)
    clearText()
    setAttachments([])
    setPlusOpen(false)
    // Sending closes the keyboard: the answer appears with the whole conversation
    // in view instead of a strip of it above the keyboard.
    Keyboard.dismiss()
  }, [disabled, sendDisabled, isStreaming, sessionId, queueText, buildOptions, onSend, attachments, clearText])

  const handleSend = useCallback(() => submitText(text), [submitText, text])

  const handleSchedule = useCallback(() => {
    setScheduleSheetVisible(true)
  }, [])

  const handleScheduleConfirm = useCallback(
    async (timestamp: number) => {
      const trimmed = text.trim()
      if (!trimmed) return

      let sid = sessionId
      if (!sid) {
        if (!onCreateSession) return
        const session = await onCreateSession()
        if (!session) return
        sid = session.id
        onNavigateToSession?.(sid)
      }

      const modeNow = useWorkspaceStore.getState().mode
      const resolved = resolveSlashAction(trimmed, modeNow)
      const model = sessionModelFor(sid)
      enqueueScheduled(sid, withReplyPrefix(sessionId, resolved?.prompt ?? trimmed), buildOptions(), modeNow, timestamp, {
        providerId: model?.providerId,
        modelId: model?.modelId,
        files: attachments.length > 0 ? attachments : undefined,
      })
      clearText()
      setAttachments([])
      Keyboard.dismiss()
    },
    [text, sessionId, onCreateSession, onNavigateToSession, enqueueScheduled, buildOptions, attachments, clearText],
  )

  // Live call: the phone has no call engine of its own — the dictation records and the
  // desktop transcribes. What it does today is the turn: speak, stop, and the text
  // already goes as a message (marked as a call, so the answer comes back speakable).
  // `liveActive` is state (and not a ref) because the banner and the icons render it.
  const [liveActive, setLiveActive] = useState(false)
  const insertDictation = useCallback((dictated: string) => {
    if (liveActive) {
      setLiveActive(false)
      submitText(dictated, true)
      return
    }
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${dictated}` : dictated))
    inputRef.current?.focus()
  }, [liveActive, submitText])
  const dictation = useDictation(insertDictation)

  const handleLiveCall = useCallback(() => {
    setLiveActive(true)
    dictation.toggle()
  }, [dictation])

  const hasText = text.trim().length > 0
  const showSend = hasText || !!isStreaming

  // Built once, on the left of the field.
  const plusButton = (
    <TouchableOpacity
      onPress={() => setPlusOpen(true)}
      activeOpacity={0.7}
      className="h-10 w-10 items-center justify-center rounded-full"
      accessibilityLabel={t('attachment.more')}
    >
      <Plus size={22} color={tokens.mutedForeground} />
    </TouchableOpacity>
  )

  // Right slot while there is nothing to send: dictation next to the live call — the same
  // control as the desktop (primary with the dark icon), in the place of "send".
  const voiceSlot = (
    <View className="flex-row items-center gap-0.5">
      <TouchableOpacity
        onPress={() => { setLiveActive(false); dictation.toggle() }}
        disabled={disabled || dictation.transcribing}
        activeOpacity={0.75}
        className="h-10 w-10 items-center justify-center rounded-full"
        accessibilityLabel={dictation.recording ? t('promptInput.voice.stop') : t('promptInput.voice.record')}
      >
        {dictation.transcribing
          ? <ActivityIndicator size="small" color={tokens.mutedForeground} />
          : <Mic size={22} color={dictation.recording ? tokens.destructive : tokens.mutedForeground} />}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={handleLiveCall}
        disabled={disabled || dictation.transcribing}
        activeOpacity={0.8}
        className="h-10 w-10 items-center justify-center rounded-full"
        style={{ backgroundColor: dictation.recording && liveActive ? tokens.destructive : tokens.primary }}
        accessibilityLabel={t('promptInput.voice.call')}
      >
        {dictation.transcribing && liveActive
          ? <ActivityIndicator size="small" color={tokens.primaryForeground} />
          : <AudioLines size={20} color={tokens.primaryForeground} />}
      </TouchableOpacity>
    </View>
  )

  // Same slot in both layouts: "send" while there is text, "voice" while there is not.
  const rightSlot = showSend ? (
    <SendButtonGroup
      onSend={handleSend}
      onStop={onAbort}
      onQueue={handleQueue}
      onStopAndSend={handleStopAndSend}
      onSchedule={handleSchedule}
      isStreaming={!!isStreaming}
      hasText={hasText}
      disabled={disabled || sendDisabled}
    />
  ) : (
    voiceSlot
  )

  return (
    <View className="px-3 pt-1.5 relative overflow-visible"
      style={{
        backgroundColor: tokens.background,
        borderTopWidth: 1,
        borderTopColor: tokens.border,
        // 6 = the py-1.5 that the bottom padding replaces.
        paddingBottom: closedBreath + 6,
      }}
    >
      {/* Queue Indicator */}
      {sessionId && (
        <View className="mb-1.5">
          <QueueIndicator sessionId={sessionId} />
        </View>
      )}

      {/* Attachments — outside the pill, as chips above it (variant A) */}
      {attachments.length > 0 && (
        <View className="flex-row flex-wrap gap-2 mb-2">
          {attachments.map((file) => (
            <InputAttachment key={file.id} file={file} onRemove={() => handleRemoveAttachment(file.id)} />
          ))}
        </View>
      )}

      {/* Reply quote and dictation status — above the pill, never inside it */}
      <ReplyBar sessionId={sessionId} />
      {dictation.recording && (
        <View className="flex-row items-center gap-2 mb-1.5">
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.destructive }} />
          <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
            {t(liveActive ? 'promptInput.voice.live' : 'promptInput.voice.recording')}
          </Text>
        </View>
      )}
      {dictation.error && (
        <View className="flex-row items-center gap-2 mb-1.5">
          <Text className="text-xs flex-1" style={{ color: tokens.destructive }}>{dictation.error}</Text>
          <TouchableOpacity onPress={dictation.clearError} activeOpacity={0.7}>
            <X size={14} color={tokens.mutedForeground} />
          </TouchableOpacity>
        </View>
      )}

      {/* Attachments & Input border box */}
      <SlashPaletteShell value={text} setText={setText}>
      <View
        className="overflow-hidden px-2 py-1"
        style={{
          borderWidth: 1,
          backgroundColor: tokens.card,
          borderColor: isFocused ? tokens.mutedForeground : tokens.border,
          borderRadius: 24,
        }}
      >
        {/* Field and actions on one row, bottom-anchored: the buttons stay put and the
            field grows upward as it gains lines (the card grows up, the bottom is fixed). */}
        <View className="flex-row items-end">
          <View style={{ marginBottom: actionLift }}>{plusButton}</View>
          {/* The vertical padding lives on this wrapper, NOT on the field. It is measured
              once at rest (one line) and the actions are lifted by half the excess over their
              own height, so the icon centre lands on the text centre; as the field grows the
              buttons stay anchored to the bottom of the card. */}
          <View
            style={{ flex: 1, paddingTop: INPUT_VERTICAL_PADDING, paddingBottom: INPUT_VERTICAL_PADDING }}
            onLayout={(event) => {
              const height = event.nativeEvent.layout.height
              // The resting height is the smallest measured (one line) — growing never lowers
              // it, so it is a safe single-line baseline to derive the lift from.
              if (oneLineFieldHeightRef.current === 0 || height < oneLineFieldHeightRef.current) {
                oneLineFieldHeightRef.current = height
                setActionLift(Math.max(0, (height - ACTION_SIZE) / 2))
              }
            }}
          >
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={setText}
              placeholder={t('promptInput.placeholder')}
              placeholderTextColor={tokens.mutedForeground}
              multiline
              maxLength={4096}
              editable={!disabled}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              submitBehavior="newline"
              style={[
                {
                  color: tokens.foreground,
                  fontSize: 16,
                  lineHeight: INPUT_LINE_HEIGHT,
                  includeFontPadding: false,
                  paddingTop: 0,
                  paddingBottom: 0,
                  maxHeight: INPUT_MAX_LINES * INPUT_LINE_HEIGHT,
                  outlineStyle: 'none',
                } as any,
                Platform.OS === 'web' ? { outlineStyle: 'none' } : undefined,
              ]}
            />
          </View>
          <View style={{ marginBottom: actionLift }}>{rightSlot}</View>
        </View>
      </View>
      </SlashPaletteShell>

      {/* Bottom sheet: attachments, model and settings — the settings slide to the modes */}
      <AttachmentSheet
        visible={plusOpen}
        onClose={() => { setPlusOpen(false); setStartOnFolders(false) }}
        onCamera={handleTakePhoto}
        onPhotos={handlePickPhotos}
        onFiles={handlePickFiles}
        modelLabel={modelLabel}
        modelProviderId={selected?.providerId}
        sessionId={sessionId}
        folders={folders}
        onFoldersChange={onFoldersChange}
        startOnFolders={startOnFolders}
        modes={sheetModes}
        tools={sheetTools}
        onToolToggle={handleToolToggle}
        thinking={thinking}
        reasoningVariants={model?.variants ?? []}
        reasoningSelected={variantId}
        reasoningAlwaysOn={model?.reasoningAlwaysOn}
        onThinkingOff={() => update({ enabled: false, variantId })}
        onReasoningSelect={(id) => update({ enabled: true, variantId: id })}
        permissionMode={permissionMode}
        onPermissionModeChange={(mode) => setPermissionMode(sessionId, mode)}
      />

      <WorkerModelModal visible={workerConfigOpen} onClose={() => setWorkerConfigOpen(false)} />
      <VisionConfigModal visible={visionConfigOpen} onClose={() => setVisionConfigOpen(false)} targetSession={sessionId} />
      <LoopConfigModal visible={loopConfigOpen} onClose={() => setLoopConfigOpen(false)} />
      <ScheduleSheet
        visible={scheduleSheetVisible}
        onClose={() => setScheduleSheetVisible(false)}
        onConfirm={handleScheduleConfirm}
      />
    </View>
  )
}

// Shell that moves useSlashCommands (which subscribes to the mode) out of the body of
// PromptInput: when switching the tab, only this shell re-renders and recomputes the
// commands — PromptInput stays intact (the memo of ChatInput holds).
const SlashPaletteShell = memo(function SlashPaletteShell({
  value,
  setText,
  children,
}: {
  value: string
  setText: (t: string) => void
  children: ReactNode
}) {
  const commands = useSlashCommands()
  return (
    // "@" is the REFERENCES palette (skills, MCP); "/" is the COMMANDS one.
    <ReferencePaletteShell value={value} setText={setText}>
      <SlashPalette value={value} setText={setText} commands={commands}>
        {children}
      </SlashPalette>
    </ReferencePaletteShell>
  )
})

const ReferencePaletteShell = memo(function ReferencePaletteShell({
  value,
  setText,
  children,
}: {
  value: string
  setText: (t: string) => void
  children: ReactNode
}) {
  const commands = useReferenceCommands()
  return (
    <SlashPalette value={value} setText={setText} commands={commands} trigger="@">
      {children}
    </SlashPalette>
  )
})
