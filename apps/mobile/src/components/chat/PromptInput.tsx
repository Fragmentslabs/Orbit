import { useState, useRef, useCallback, useEffect, memo, type ReactNode } from 'react'
import { View, TextInput, Pressable, Text, ScrollView, ActivityIndicator, Platform, TouchableOpacity } from 'react-native'
import {
  Search,
  Globe,
  AlignLeft,
  BrainCircuit,
  Plus,
  Bot,
  Network,
  FileText,
  Settings2,
  RefreshCw,
  Eye,
  Mic,
  X,
} from 'lucide-react-native'
import {  } from 'expo-image'
import { useTranslation } from 'react-i18next'
import type { SendMessageOptions, FilePart, SessionInfo } from '@orbit/shared'
import { resolveSlashAction } from '@orbit/shared'
import {  } from '~/lib/utils'
import { ContextMeter } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import { AttachmentSheet } from './AttachmentSheet'
import { WorkerModelModal } from './WorkerModelModal'
import { VisionConfigModal } from './VisionConfigModal'
import { LoopConfigModal } from './LoopConfigModal'
import { InputAttachment } from './Attachment'
import { ConfigSheet } from './ConfigSheet'
import { SlashPalette } from './SlashPalette'
import { useSlashCommands, useReferenceCommands } from '~/hooks/useSlashCommands'
import { useDictation } from '~/hooks/useDictation'
import { useConnectionStore } from '~/stores/connection-store'
import { uriToFilePart } from '~/lib/attachments'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useAppearanceStore, type ModeId } from '~/stores/appearance-store'
import { useSessionReasoningPref } from '~/stores/session-reasoning'
import { usePermissionMode, usePermissionPrefs } from '~/stores/permission-prefs'
import { useModelModePrefs } from '~/stores/model-mode-prefs'
import { useModeActive, useModeOverrides } from '~/stores/mode-overrides'
import { useSimpleMode, useSimplePrefs } from '~/stores/simple-prefs'
import { useBrainEnabled, useBrainPrefs } from '~/stores/brain-prefs'
import { Storage } from '~/lib/storage'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useBottomBreathing } from '~/lib/keyboard'
import { useThemeStore } from '~/stores/theme-store'
import { SendButtonGroup } from './SendButtonGroup'
import { QueueIndicator } from './QueueIndicator'
import { ScheduleSheet } from './ScheduleSheet'
import { useMessageQueueStore } from '~/stores/message-queue-store'
import { useSessionStore, useSessionModel } from '~/stores/session-store'
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
}

async function fileToFilePart(asset: any): Promise<FilePart> {
  return uriToFilePart(asset.uri, asset.mimeType, asset.name)
}

// First-time notice (workers): the modal only opens on the 1st activation of agent mode
// without a configured worker; "use the same model as the chat" is valid (persisted)
const WORKER_CONFIG_PROMPTED_KEY = 'orbit_worker_config_prompted'

export function PromptInput({
  onSend,
  onAbort,
  isStreaming,
  sessionId,
  disabled,
  sendDisabled,
  onCreateSession,
  onNavigateToSession,
}: PromptInputProps) {
  const { t } = useTranslation()
  // Active modes per chat: override (mode-overrides/simple/brain) ?? default
  // (model-mode-prefs, separated by chat/code mode) — mirror of the desktop.
  const workspaceMode = useWorkspaceStore((s) => s.mode)
  const modeDefaults = useModelModePrefs((s) =>
    workspaceMode === 'code' ? s.codeActiveModes : s.chatActiveModes,
  )
  const search = useModeActive('search', sessionId, modeDefaults.search)
  const browser = useModeActive('browser', sessionId, modeDefaults.browser)
  const simple = useSimpleMode(sessionId, modeDefaults.simple)
  const brain = useBrainEnabled(sessionId, modeDefaults.brain)
  const plan = useModeActive('plan', sessionId, modeDefaults.plan)
  const subagents = useModeActive('subagents', sessionId, modeDefaults.subagents)
  const orchestra = useModeActive('orchestra', sessionId, modeDefaults.orchestra)
  const vision = useModeActive('vision', sessionId, modeDefaults.vision)
  const setModeActive = useModeOverrides((s) => s.setMode)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const setBrainEnabled = useBrainPrefs((s) => s.setEnabled)

  const [text, setText] = useState('')
  const [loop, setLoop] = useState(false)
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
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [workerConfigOpen, setWorkerConfigOpen] = useState(false)
  const [loopConfigOpen, setLoopConfigOpen] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
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

  const http = useConnectionStore((s) => s.http)
  const [gitBranches, setGitBranches] = useState<string[]>([])
  const [gitCurrent, setGitCurrent] = useState<string>('')
  const [gitBranchLoading, setGitBranchLoading] = useState(false)

  useEffect(() => {
    if (!http) return
    let cancelled = false
    const fetch = async () => {
      setGitBranchLoading(true)
      const res = await http.getBranches('')
      if (cancelled) return
      setGitBranchLoading(false)
      if (res.ok && res.data) {
        setGitBranches(res.data.branches)
        setGitCurrent(res.data.current)
      }
    }
    fetch()
    return () => { cancelled = true }
  }, [http])

  const handleGitBranchChange = useCallback(async (branch: string) => {
    if (!http) return
    setGitCurrent(branch)
    await http.checkoutBranch('', branch)
  }, [http])

  const catalog = useSettingsStore((s) => s.catalog)
  // EFFECTIVE model of the session (per-chat override > draft > global default) —
  // parity with the desktop (chat-input), where thinking follows the model of the
  // open chat, not the global default of the app.
  const selected = useSessionModel(sessionId)
  const model = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]
    : undefined
  // Thinking PER CHAT: without a choice in this conversation, the level of the model applies.
  const { enabled, variantId, update, hydrate, hydrated } = useSessionReasoningPref(sessionId, selected?.providerId, selected?.modelId)
  // Thinking: the default of the preferences defines the default; reasoning of the model
  // and models with reasoningAlwaysOn keep applying as before
  const thinking = modeDefaults.thinking || enabled || !!model?.reasoningAlwaysOn
  const workerModel = useSettingsStore((s) => s.workerModel)
  const workerModelLabel = workerModel && catalog
    ? catalog[workerModel.providerId]?.models[workerModel.modelId]?.name ?? `${workerModel.providerId}/${workerModel.modelId}`
    : null
  const visionModel = useSettingsStore((s) => s.visionModel)
  const visionConfigOpen = useSettingsStore((s) => s.visionConfigOpen)
  const setVisionConfigOpen = useSettingsStore((s) => s.setVisionConfigOpen)
  const modesInRow = useAppearanceStore((s) => s.modesInRow)

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

  // Dictation: records on the device (PCM16 mono 16 kHz) and asks the desktop for the
  // transcription (the phone does not run a voice model). The text comes back to the input
  // as if it had been typed, respecting the per-chat draft.
  const insertDictation = useCallback((dictated: string) => {
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${dictated}` : dictated))
    inputRef.current?.focus()
  }, [])
  const dictation = useDictation(insertDictation)

  // Workers: first-time notice — it only opens on the 1st activation without a configured
  // worker ("use the same model" is valid); after that, never again.
  const [workerConfigPrompted, setWorkerConfigPrompted] = useState(false)

  // Declared before toggleMode because it routes subagents/orchestra to
  // here — and reading a ref during render is not allowed.
  const toggleWorkerMode = useCallback((id: 'subagents' | 'orchestra', next: boolean) => {
    setModeActive(id, sessionId, next)
    if (next && !workerModel && !workerConfigPrompted) {
      setWorkerConfigPrompted(true)
      Storage.setItem(WORKER_CONFIG_PROMPTED_KEY, '1').catch(() => {})
      setWorkerConfigOpen(true)
    }
  }, [workerModel, workerConfigPrompted, sessionId, setModeActive])

  const toggleMode = useCallback((id: string) => {
    // Vision mode is per-chat (mode-overrides); turning it on without a configured model
    // opens the configuration (same gate as the desktop).
    if (id === 'vision') {
      const next = !vision
      if (next && !visionModel) {
        setVisionConfigOpen(true)
        return
      }
      setModeActive('vision', sessionId, next)
      return
    }
    if (id === 'research') return setModeActive('search', sessionId, !search)
    if (id === 'browser') return setModeActive('browser', sessionId, !browser)
    if (id === 'simple') return setSimple(sessionId, !simple)
    if (id === 'brain') return setBrainEnabled(sessionId, !brain)
    if (id === 'plan') return setModeActive('plan', sessionId, !plan)
    if (id === 'subagents') return toggleWorkerMode('subagents', !subagents)
    if (id === 'orchestra') return toggleWorkerMode('orchestra', !orchestra)
    if (id === 'loop') return setLoop((v) => !v)
  }, [vision, visionModel, sessionId, search, browser, simple, brain, plan, subagents, orchestra, setModeActive, setSimple, setBrainEnabled, setVisionConfigOpen, setLoop, toggleWorkerMode])

  // Configuration gate: only opens the modal when the user TURNS ON the mode.
  useEffect(() => {
    Storage.getItem(WORKER_CONFIG_PROMPTED_KEY)
      .then((v) => { if (v === '1') setWorkerConfigPrompted(true) })
      .catch(() => {})
  }, [])


  const handlePickFiles = async () => {
    setPlusOpen(false)
    setIsLoadingFile(true)
    try {
      const DocumentPicker = await import('expo-document-picker')
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
    } finally {
      setIsLoadingFile(false)
    }
  }

  const handleTakePhoto = async () => {
    setPlusOpen(false)
    setIsLoadingFile(true)
    try {
      // The import and the permission stay INSIDE the try: outside it, a failure to
      // load the module became an unhandled rejection (red screen in dev)
      // instead of a handled error, and the loading was never turned off.
      const ImagePicker = await import('expo-image-picker')
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
    } finally {
      setIsLoadingFile(false)
    }
  }

  const handlePickPhotos = async () => {
    setPlusOpen(false)
    setIsLoadingFile(true)
    try {
      const ImagePicker = await import('expo-image-picker')
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
    } finally {
      setIsLoadingFile(false)
    }
  }

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id))
  }

  const buildOptions = useCallback(() => {
    const modeNow = useWorkspaceStore.getState().mode
    return {
      research: search,
      browser,
      simple,
      brain,
      reasoning: { enabled: thinking, variantId },
      plan: modeNow === 'code' ? plan : undefined,
      subagents,
      orchestrate: orchestra && modeNow === 'code' ? {} : undefined,
      loop,
      permissionMode: modeNow === 'code' ? permissionMode : undefined,
      // Mode coming from the selector: on the desktop it applies already to the next tool of the
      // answer in progress. Now the main resolves by the level of THIS chat, so the
      // same contract applies here without leaking to the others.
      followGlobalPermission: modeNow === 'code' ? true : undefined,
    } satisfies SendMessageOptions
  }, [search, browser, simple, brain, thinking, variantId, plan, subagents, orchestra, loop, permissionMode])

  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)

  const handleQueue = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId) return
    const modeNow = useWorkspaceStore.getState().mode
    const resolved = resolveSlashAction(trimmed, modeNow)
    // The quote comes in AFTER the "/" command is resolved: in front of it, the
    // text would stop starting with "/" and the command would become conversation.
    enqueueForSend(sessionId, withReplyPrefix(sessionId, resolved?.prompt ?? trimmed), buildOptions(), modeNow, {
      files: attachments.length > 0 ? attachments : undefined,
    })
    setText('')
    setAttachments([])
  }, [text, sessionId, enqueueForSend, buildOptions, attachments])

  const handleStopAndSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId) return
    const modeNow = useWorkspaceStore.getState().mode
    const resolved = resolveSlashAction(trimmed, modeNow)
    onAbort()
    enqueueForSend(sessionId, withReplyPrefix(sessionId, resolved?.prompt ?? trimmed), buildOptions(), modeNow, {
      files: attachments.length > 0 ? attachments : undefined,
    })
    setText('')
    setAttachments([])
  }, [text, sessionId, onAbort, enqueueForSend, buildOptions, attachments])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled || sendDisabled) return

    // Agent running: instead of blocking the send (it made the text get stuck
    // in the input when pressing Enter), it sends to the session queue — the same
    // "send to the side panel" of the desktop — and clears the input so the
    // user can keep typing while the agent works.
    if (isStreaming) {
      if (sessionId) {
        handleQueue()
      } else {
        setText('')
        setAttachments([])
      }
      return
    }

    const modeNow = useWorkspaceStore.getState().mode
    const options: SendMessageOptions = buildOptions()

    // "/" commands become the prompt of the corresponding pipeline
    const resolved = resolveSlashAction(trimmed, modeNow)
    const finalText = withReplyPrefix(sessionId, resolved?.prompt ?? trimmed)

    onSend(finalText, options, attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
    setPlusOpen(false)
  }, [text, isStreaming, disabled, sendDisabled, onSend, handleQueue, sessionId, buildOptions, attachments])

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
      enqueueScheduled(sid, withReplyPrefix(sessionId, resolved?.prompt ?? trimmed), buildOptions(), modeNow, timestamp, {
        files: attachments.length > 0 ? attachments : undefined,
      })
      setText('')
      setAttachments([])
    },
    [text, sessionId, onCreateSession, onNavigateToSession, enqueueScheduled, buildOptions, attachments],
  )

  // Single row, in the SAME order as the desktop code-input (search, plan,
  // simple, brain, subagents, orchestra, loop, vision). The advanced ones were a
  // separate row, but the desktop order interleaves them — plan comes before
  // simple —, so there is no way to keep two blocks.
  //
  // Browser stays out of code mode: there it does not even exist on the desktop (the browser
  // of the right panel is another thing).
  const isCodeMode = workspaceMode === 'code'
  const modesList = [
    { id: 'research', icon: Search, label: t('promptInput.modes.research') },
    ...(isCodeMode
      ? [{ id: 'plan', icon: FileText, label: t('promptInput.modes.plan') }]
      : [{ id: 'browser', icon: Globe, label: t('promptInput.modes.browser') }]),
    { id: 'simple', icon: AlignLeft, label: t('promptInput.modes.simple') },
    { id: 'brain', icon: BrainCircuit, label: t('promptInput.modes.brain') },
    { id: 'subagents', icon: Bot, label: t('promptInput.modes.subagents') },
    ...(isCodeMode
      ? [{ id: 'orchestra', icon: Network, label: t('promptInput.modes.orchestra') }]
      : []),
    { id: 'loop', icon: RefreshCw, label: t('promptInput.modes.loop') },
    { id: 'vision', icon: Eye, label: t('promptInput.modes.vision') },
  ]

  // Maps the row id to the modesInRow id (mirror of the desktop) — the row
  // shows only the modes checked in the preferences; the "+" always shows all of them.
  const ROW_TO_MODE_ID: Record<string, ModeId> = {
    research: 'search',
    browser: 'browser',
    plan: 'plan',
    simple: 'simple',
    brain: 'brain',
    subagents: 'subagents',
    orchestra: 'orchestra',
    loop: 'loop',
    vision: 'vision',
  }
  const visibleModes = modesList.filter((m) => modesInRow.includes(ROW_TO_MODE_ID[m.id]))

  // Effective state of each toggle in the row
  const simpleActive: Record<string, boolean> = {
    research: search,
    browser,
    plan,
    simple,
    brain,
    subagents,
    orchestra,
    loop,
    vision,
  }

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

      {/* Attachments & Input border box */}
      <SlashPaletteShell value={text} setText={setText}>
      <View
        className="rounded-2xl overflow-hidden px-3 py-1 mb-2"
        style={{
          borderWidth: 1,
          backgroundColor: tokens.card,
          borderColor: isFocused ? tokens.mutedForeground : tokens.border,
        }}
      >
        {/* Attachments horizontal list */}
        {attachments.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="pt-1.5 pb-3 mb-1"
            style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
            contentContainerStyle={{ gap: 8 }}
          >
            {attachments.map((file) => (
              <InputAttachment key={file.id} file={file} onRemove={() => handleRemoveAttachment(file.id)} />
            ))}
          </ScrollView>
        )}

        {/* Loading Indicator for Files */}
        {isLoadingFile && (
          <View className="flex-row items-center gap-2 py-1 mb-1"
            style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
          >
            <ActivityIndicator size="small" color={tokens.primary} />
            <Text className="text-xs" style={{ color: tokens.mutedForeground }}>{t('promptInput.loadingFile')}</Text>
          </View>
        )}

        {/* Replied message — quote above the field, as in WhatsApp */}
        <ReplyBar sessionId={sessionId} />

        {/* Dictation: recording now */}
        {dictation.recording && (
          <View className="flex-row items-center gap-2 py-1 mb-1"
            style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.destructive }} />
            <Text className="text-xs" style={{ color: tokens.mutedForeground }}>{t('promptInput.voice.recording')}</Text>
          </View>
        )}

        {/* Dictation: visible error (permission, offline, voice engine unavailable) */}
        {dictation.error && (
          <View className="flex-row items-center gap-2 py-1 mb-1"
            style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
          >
            <Text className="text-xs flex-1" style={{ color: tokens.destructive }}>{dictation.error}</Text>
            <TouchableOpacity onPress={dictation.clearError} activeOpacity={0.7}>
              <X size={14} color={tokens.mutedForeground} />
            </TouchableOpacity>
          </View>
        )}

        {/* Text Area Input */}
        <View className="flex-row items-end">
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
              { color: tokens.foreground, outlineStyle: 'none' } as any,
              Platform.OS === 'web' ? { outlineStyle: 'none' } : undefined,
            ]}
            className="flex-1 py-1.5 text-base max-h-24 min-h-[36px]"
          />
        </View>

        {/* Footer Row — no separator, same as the desktop */}
        <View className="flex-row items-center justify-between pt-1.5 pb-1 mt-1">
          {/* Plus + Config actions */}
          <View className="flex-row items-center gap-1">
            <TouchableOpacity
              onPress={() => setPlusOpen(true)}
              activeOpacity={0.7}
              className="p-1.5 rounded-md cursor-pointer"
            >
              <Plus size={20} color={tokens.mutedForeground} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setConfigOpen(true)}
              activeOpacity={0.7}
              className="p-1.5 rounded-md cursor-pointer"
            >
              <Settings2 size={18} color={tokens.mutedForeground} />
            </TouchableOpacity>
            {/* Dictation: tap to record, tap again to stop and transcribe */}
            <TouchableOpacity
              onPress={dictation.toggle}
              disabled={disabled || dictation.transcribing}
              activeOpacity={0.7}
              className="p-1.5 rounded-md cursor-pointer"
              accessibilityLabel={dictation.recording ? t('promptInput.voice.stop') : t('promptInput.voice.record')}
            >
              {dictation.transcribing
                ? <ActivityIndicator size="small" color={tokens.mutedForeground} />
                : <Mic size={20} color={dictation.recording ? tokens.destructive : tokens.mutedForeground} />}
            </TouchableOpacity>
          </View>

          {/* Model picker & controls */}
          <View className="flex-row items-center gap-2">
            {/* Model Picker */}
            <ModelPicker sessionId={sessionId} />

            {/* Send/Stop Button */}
            <SendButtonGroup
              onSend={handleSend}
              onStop={onAbort}
              onQueue={handleQueue}
              onStopAndSend={handleStopAndSend}
              onSchedule={handleSchedule}
              isStreaming={!!isStreaming}
              hasText={text.trim().length > 0}
              disabled={disabled || sendDisabled}
            />
          </View>
        </View>
      </View>
      </SlashPaletteShell>

      {/* Mode Toggles Row — always visible on mobile (toggles + "+" fixed) */}
      <View className="flex-row items-center justify-between px-1">
        <View className="flex-row items-center gap-2">
          {/* Thinking does not come in here: its control (with the choice of
              variant) already lives in the settings sheet. */}
          {visibleModes.map((mode) => {
            const isActive = simpleActive[mode.id] ?? false
            const IconComponent = mode.icon
            return (
              <Pressable
                key={mode.id}
                onPress={() => toggleMode(mode.id)}
                disabled={isStreaming}
                className="p-2 rounded-md"
                style={isActive ? { backgroundColor: tokens.muted } : { opacity: 0.4 }}
              >
                <IconComponent
                  size={17}
                  // Every active mode lights up the same (white), with the muted background
                  // marking the state — the advanced ones no longer light up in amber,
                  // which gave the impression of two kinds of toggle in the row.
                  color={isActive ? tokens.foreground : tokens.mutedForeground}
                />
              </Pressable>
            )
          })}
        </View>
        <ContextMeter sessionId={sessionId} />
      </View>

      {/* Bottom sheet */}
      <AttachmentSheet
        visible={plusOpen}
        onClose={() => setPlusOpen(false)}
        onCamera={handleTakePhoto}
        onPhotos={handlePickPhotos}
        onFiles={handlePickFiles}
        // The cut between the two groups is having a gear or not: at the top the plain
        // toggles, below the ones that open their own configuration. Thinking
        // stays out — it lives in ConfigSheet, where one can choose the
        // reasoning variant.
        simpleModes={[
          ...(workspaceMode === 'code' ? [{ id: 'plan', icon: FileText, label: t('promptInput.modes.plan'), active: plan, onToggle: () => setModeActive('plan', sessionId, !plan) }] : []),
          { id: 'research', icon: Search, label: t('promptInput.modes.research'), active: search, onToggle: () => toggleMode('research') },
          // Browser only in chat mode, same as the row and the desktop.
          ...(workspaceMode === 'code'
            ? []
            : [{ id: 'browser', icon: Globe, label: t('promptInput.modes.browser'), active: browser, onToggle: () => toggleMode('browser') }]),
          { id: 'simple', icon: AlignLeft, label: t('promptInput.modes.simple'), active: simple, onToggle: () => toggleMode('simple') },
          { id: 'brain', icon: BrainCircuit, label: t('promptInput.modes.brain'), active: brain, onToggle: () => toggleMode('brain') },
        ]}
        configModes={[
          { id: 'vision', icon: Eye, label: t('promptInput.modes.vision'), active: vision, onToggle: () => toggleMode('vision'), onConfigure: () => { setPlusOpen(false); setVisionConfigOpen(true) } },
          { id: 'subagents', icon: Bot, label: t('promptInput.modes.subagents'), active: subagents, onToggle: () => toggleWorkerMode('subagents', !subagents), onConfigure: () => { setPlusOpen(false); setWorkerConfigOpen(true) } },
          ...(workspaceMode === 'code' ? [{ id: 'orchestra', icon: Network, label: t('promptInput.modes.orchestra'), active: orchestra, onToggle: () => toggleWorkerMode('orchestra', !orchestra), onConfigure: () => { setPlusOpen(false); setWorkerConfigOpen(true) } }] : []),
          { id: 'loop', icon: RefreshCw, label: t('promptInput.modes.loop'), active: loop, onToggle: () => setLoop((v) => !v), onConfigure: () => { setPlusOpen(false); setLoopConfigOpen(true) } },
        ]}
      />

      <ConfigSheet
        visible={configOpen}
        onClose={() => setConfigOpen(false)}
        permissionMode={permissionMode}
        onPermissionModeChange={(mode) => setPermissionMode(sessionId, mode)}
        thinking={thinking}
        onThinkingToggle={() => update({ enabled: !enabled, variantId })}
        reasoningVariants={model?.variants ?? []}
        reasoningSelected={variantId}
        onReasoningSelect={(id) => update({ enabled: true, variantId: id })}
        reasoningAlwaysOn={model?.reasoningAlwaysOn}
        subagents={subagents}
        onSubagentsToggle={() => toggleWorkerMode('subagents', !subagents)}
        orchestra={orchestra}
        onOrchestraToggle={() => toggleWorkerMode('orchestra', !orchestra)}
        loop={loop}
        onLoopToggle={() => setLoop((prev) => !prev)}
        workerModelLabel={workerModelLabel}
        onConfigureWorkers={() => {
          setConfigOpen(false)
          setWorkerConfigOpen(true)
        }}
        vision={vision}
        onVisionToggle={() => toggleMode('vision')}
        onConfigureVision={() => {
          setConfigOpen(false)
          setVisionConfigOpen(true)
        }}
        onConfigureLoop={() => {
          setConfigOpen(false)
          setLoopConfigOpen(true)
        }}
        mode={workspaceMode}
        gitBranches={gitBranches}
        gitCurrent={gitCurrent}
        onGitBranchChange={handleGitBranchChange}
        gitBranchLoading={gitBranchLoading}
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
