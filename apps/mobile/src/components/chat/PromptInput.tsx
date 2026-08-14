import { useState, useRef, useCallback, useEffect, memo, type ReactNode } from 'react'
import { View, TextInput, Pressable, Text, ScrollView, ActivityIndicator, Platform, TouchableOpacity } from 'react-native'
import {
  Search,
  Globe,
  Brain,
  AlignLeft,
  BrainCircuit,
  Plus,
  Bot,
  Network,
  FileText,
  X,
  Paperclip,
  ArrowUp,
  Square,
  Settings2,
  RefreshCw,
  Eye,
} from 'lucide-react-native'
import { Image } from 'expo-image'
import { useTranslation } from 'react-i18next'
import type { SendMessageOptions, FilePart, SessionInfo } from '@orbit/shared'
import { resolveSlashAction } from '@orbit/shared'
import { cn } from '~/lib/utils'
import { ContextMeter } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import { AttachmentSheet } from './AttachmentSheet'
import { WorkerModelModal } from './WorkerModelModal'
import { VisionConfigModal } from './VisionConfigModal'
import { LoopConfigModal } from './LoopConfigModal'
import { InputAttachment } from './Attachment'
import { ConfigSheet } from './ConfigSheet'
import { SlashPalette } from './SlashPalette'
import { useSlashCommands } from '~/hooks/useSlashCommands'
import { useConnectionStore } from '~/stores/connection-store'
import { uriToFilePart } from '~/lib/attachments'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useAppearanceStore } from '~/stores/appearance-store'
import { useReasoningPrefs } from '~/stores/reasoning-prefs'
import { useModelModePrefs } from '~/stores/model-mode-prefs'
import { useModeActive, useModeOverrides } from '~/stores/mode-overrides'
import { useSimpleMode, useSimplePrefs } from '~/stores/simple-prefs'
import { useBrainEnabled, useBrainPrefs } from '~/stores/brain-prefs'
import { useModelConfigPrompt } from '~/hooks/use-model-config-prompt'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SendButtonGroup } from './SendButtonGroup'
import { QueueIndicator } from './QueueIndicator'
import { ScheduleSheet } from './ScheduleSheet'
import { useMessageQueueStore } from '~/stores/message-queue-store'
import { useSessionStore } from '~/stores/session-store'
import { useDraftInput } from '~/stores/draft-input-store'
import { setInputDraft, getInputDraft } from '~/stores/chat-draft-store'

interface PromptInputProps {
  onSend: (text: string, options: SendMessageOptions, files?: FilePart[]) => void
  onAbort: () => void
  isStreaming?: boolean
  sessionId?: string
  disabled?: boolean
  onCreateSession?: () => Promise<SessionInfo | null>
  onNavigateToSession?: (sessionId: string) => void
}

async function fileToFilePart(asset: any): Promise<FilePart> {
  return uriToFilePart(asset.uri, asset.mimeType, asset.name)
}

export function PromptInput({
  onSend,
  onAbort,
  isStreaming,
  sessionId,
  disabled,
  onCreateSession,
  onNavigateToSession,
}: PromptInputProps) {
  const { t } = useTranslation()
  // Modos ativos por chat: override (mode-overrides/simple/brain) ?? default
  // (model-mode-prefs, separado por modo chat/code) — espelho do desktop.
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
  textRef.current = text

  // Plano aceito → desliga o toggle de modo plano: a próxima mensagem não
  // deve gerar outro plano.
  const planReview = useSessionStore((s) => (sessionId ? s.planReviews[sessionId] : undefined))
  useEffect(() => {
    if (planReview?.status === 'implementing') setModeActive('plan', sessionId, false)
  }, [planReview, sessionId, setModeActive])

  // Restaura texto do input ao trocar de chat (per-chat draft)
  useEffect(() => {
    const prev = prevSessionIdRef.current
    if (prev !== sessionId) {
      if (prev) setInputDraft(prev, textRef.current)
      const saved = getInputDraft(sessionId ?? 'draft')
      if (saved) setText(saved)
      prevSessionIdRef.current = sessionId
    }
  }, [sessionId])
  const [attachments, setAttachments] = useState<FilePart[]>([])
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [workerConfigOpen, setWorkerConfigOpen] = useState(false)
  const [loopConfigOpen, setLoopConfigOpen] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [permissionMode, setPermissionMode] = useState<'ask' | 'approve' | 'full'>('ask')
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
  const selected = useSettingsStore((s) => s.selectedModel)
  const model = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]
    : undefined
  const { enabled, variantId, update, hydrate, hydrated } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  // Thinking: o default das preferências define o default; reasoning do modelo
  // e modelos com reasoningAlwaysOn continuam valendo como antes
  const thinking = modeDefaults.thinking || enabled || !!model?.reasoningAlwaysOn
  const workerModel = useSettingsStore((s) => s.workerModel)
  const workerModelLabel = workerModel && catalog
    ? catalog[workerModel.providerId]?.models[workerModel.modelId]?.name ?? `${workerModel.providerId}/${workerModel.modelId}`
    : null
  const visionModel = useSettingsStore((s) => s.visionModel)
  const visionConfigOpen = useSettingsStore((s) => s.visionConfigOpen)
  const setVisionConfigOpen = useSettingsStore((s) => s.setVisionConfigOpen)
  const displayMode = useAppearanceStore((s) => s.displayMode)

  useEffect(() => {
    if (!hydrated) hydrate()
  }, [hydrated, hydrate])

  // Assina o draft (não só lê na troca de sessão): o revert devolve a mensagem
  // ao input estando na mesma sessão, e um consume só no [sessionId] perderia.
  const pendingDraft = useDraftInput((s) => s.drafts[sessionId ?? 'draft'])
  useEffect(() => {
    if (pendingDraft === undefined) return
    const payload = useDraftInput.getState().consume(sessionId)
    if (!payload) return
    setText(payload.text)
    if (payload.files?.length) setAttachments((prev) => [...prev, ...payload.files!])
  }, [pendingDraft, sessionId])

  const handleKeyPress = (e: any) => {
    if (e.nativeEvent.key === 'Enter') {
      if (e.shiftKey || e.nativeEvent.shiftKey) {
        return
      }
      e.preventDefault?.()
      handleSend()
    }
  }

  const inputRef = useRef<TextInput>(null)

  const toggleMode = useCallback((id: string) => {
    // Modo Visão é per-chat (mode-overrides); ativar sem modelo configurado
    // abre a configuração (mesmo gate do desktop).
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
  }, [vision, visionModel, sessionId, search, browser, simple, brain, setModeActive, setSimple, setBrainEnabled, setVisionConfigOpen])

  // Gate de configuração (espelho do useModelConfigPrompt do desktop): modos
  // ativos por default nas preferências sem modelo configurado abrem o modal
  // de configuração automaticamente, uma vez por chat.
  useModelConfigPrompt({
    sessionId,
    subagents: workspaceMode === 'code' ? subagents : false,
    orchestra: workspaceMode === 'code' ? orchestra : false,
    vision,
    workerConfigured: workerModel != null,
    visionConfigured: visionModel != null,
    onOpenWorker: () => setWorkerConfigOpen(true),
    onOpenVision: () => setVisionConfigOpen(true),
    workerDialogOpen: workerConfigOpen,
    visionDialogOpen: visionConfigOpen,
  })

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
      console.error('Erro ao selecionar arquivos:', err)
    } finally {
      setIsLoadingFile(false)
    }
  }

  const handleTakePhoto = async () => {
    setPlusOpen(false)
    const ImagePicker = await import('expo-image-picker')
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) return
    setIsLoadingFile(true)
    try {
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 })
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0]
        const part = await uriToFilePart(asset.uri, asset.mimeType ?? 'image/jpeg', asset.fileName ?? undefined)
        setAttachments((prev) => [...prev, part])
      }
    } catch (err) {
      console.error('Erro ao tirar foto:', err)
    } finally {
      setIsLoadingFile(false)
    }
  }

  const handlePickPhotos = async () => {
    setPlusOpen(false)
    const ImagePicker = await import('expo-image-picker')
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) return
    setIsLoadingFile(true)
    try {
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
      console.error('Erro ao selecionar fotos:', err)
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
    } satisfies SendMessageOptions
  }, [search, browser, simple, brain, thinking, variantId, plan, subagents, orchestra, loop, permissionMode])

  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)

  const handleQueue = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId) return
    const modeNow = useWorkspaceStore.getState().mode
    const resolved = resolveSlashAction(trimmed, modeNow)
    enqueueForSend(sessionId, resolved?.prompt ?? trimmed, buildOptions(), modeNow)
    setText('')
    setAttachments([])
  }, [text, sessionId, enqueueForSend, buildOptions])

  const handleStopAndSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId) return
    const modeNow = useWorkspaceStore.getState().mode
    const resolved = resolveSlashAction(trimmed, modeNow)
    onAbort()
    enqueueForSend(sessionId, resolved?.prompt ?? trimmed, buildOptions(), modeNow)
    setText('')
    setAttachments([])
  }, [text, sessionId, onAbort, enqueueForSend, buildOptions])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return

    // Agente em execução: em vez de bloquear o envio (causava o texto ficar
    // preso no input ao dar Enter), manda para a fila da sessão — o mesmo
    // "enviar para o painel lateral" do desktop — e limpa o input para o
    // usuário continuar digitando enquanto o agente trabalha.
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

    // Comandos "/" viram o prompt do pipeline correspondente
    const resolved = resolveSlashAction(trimmed, modeNow)
    const finalText = resolved?.prompt ?? trimmed

    onSend(finalText, options, attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
    setPlusOpen(false)
  }, [text, isStreaming, disabled, onSend, handleQueue, sessionId, buildOptions, attachments])

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
      enqueueScheduled(sid, resolved?.prompt ?? trimmed, buildOptions(), modeNow, timestamp)
      setText('')
      setAttachments([])
    },
    [text, sessionId, onCreateSession, onNavigateToSession, enqueueScheduled, buildOptions],
  )

  const modesList = [
    { id: 'research', icon: Search, label: t('promptInput.modes.research') },
    { id: 'browser', icon: Globe, label: t('promptInput.modes.browser') },
    { id: 'simple', icon: AlignLeft, label: t('promptInput.modes.simple') },
    { id: 'brain', icon: BrainCircuit, label: t('promptInput.modes.brain') },
  ]

  // Estado efetivo dos toggles simples (modos do row principal + sheet)
  const simpleActive: Record<string, boolean> = {
    research: search,
    browser,
    simple,
    brain,
  }

  return (
    <View className="px-3 py-1.5 relative overflow-visible"
      style={{ backgroundColor: tokens.background, borderTopWidth: 1, borderTopColor: tokens.border }}
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
            className="py-1.5 mb-1"
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
            onKeyPress={handleKeyPress}
            onSubmitEditing={handleSend}
            style={[
              { color: tokens.foreground, outlineStyle: 'none' } as any,
              Platform.OS === 'web' ? { outlineStyle: 'none' } : undefined,
            ]}
            className="flex-1 py-1.5 text-base max-h-24 min-h-[36px]"
          />
        </View>

        {/* Footer Row — sem separador, igual ao desktop */}
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
          </View>

          {/* Model picker & controls */}
          <View className="flex-row items-center gap-2">
            {/* Model Picker */}
            <ModelPicker />

            {/* Send/Stop Button */}
            <SendButtonGroup
              onSend={handleSend}
              onStop={onAbort}
              onQueue={handleQueue}
              onStopAndSend={handleStopAndSend}
              onSchedule={handleSchedule}
              isStreaming={!!isStreaming}
              hasText={text.trim().length > 0}
              disabled={disabled}
            />
          </View>
        </View>
      </View>
      </SlashPaletteShell>

      {/* Mode Toggles Row — oculto em modo "actions" */}
      {displayMode !== 'actions' && (
      <View className="flex-row items-center justify-between px-1">
        <View className="flex-row items-center gap-2">
          {/* Thinking toggle — mostrado apenas se o modelo suporta reasoning */}
          {model?.reasoning && (
            <Pressable
              key="thinking"
              onPress={() => update({ enabled: !enabled, variantId })}
              disabled={isStreaming || model?.reasoningAlwaysOn}
              className="p-2 rounded-md"
              style={[
                thinking ? { backgroundColor: tokens.muted } : { opacity: 0.4 },
                model?.reasoningAlwaysOn && { opacity: 0.3 },
              ]}
            >
              <Brain
                size={17}
                color={thinking ? tokens.foreground : tokens.mutedForeground}
              />
            </Pressable>
          )}
          {modesList.map((mode) => {
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
                  color={isActive ? tokens.foreground : tokens.mutedForeground}
                />
              </Pressable>
            )
          })}
          {/* Advanced mode toggles — plan, subagents, orchestra, loop. Componente
              filho que assina o modo ele mesmo: trocar chat/código não precisa
              re-renderizar o PromptInput inteiro. */}
          <AdvancedModesRow
            plan={plan}
            subagents={subagents}
            orchestra={orchestra}
            loop={loop}
            onTogglePlan={() => setModeActive('plan', sessionId, !plan)}
            onToggleSubagents={() => setModeActive('subagents', sessionId, !subagents)}
            onToggleOrchestra={() => setModeActive('orchestra', sessionId, !orchestra)}
            onToggleLoop={() => setLoop((v) => !v)}
            tokens={tokens}
          />
        </View>
        <ContextMeter sessionId={sessionId} />
      </View>
      )}

      {/* Bottom sheet */}
      <AttachmentSheet
        visible={plusOpen}
        onClose={() => setPlusOpen(false)}
        onCamera={handleTakePhoto}
        onPhotos={handlePickPhotos}
        onFiles={handlePickFiles}
        simpleModes={[
          { id: 'research', icon: Search, label: t('promptInput.modes.research'), active: search, onToggle: () => toggleMode('research') },
          { id: 'browser', icon: Globe, label: t('promptInput.modes.browser'), active: browser, onToggle: () => toggleMode('browser') },
          { id: 'simple', icon: AlignLeft, label: t('promptInput.modes.simple'), active: simple, onToggle: () => toggleMode('simple') },
          { id: 'brain', icon: BrainCircuit, label: t('promptInput.modes.brain'), active: brain, onToggle: () => toggleMode('brain') },
          ...(model?.reasoning ? [{ id: 'thinking', icon: Brain, label: t('promptInput.modes.thinking'), active: thinking, onToggle: () => update({ enabled: !enabled, variantId }) }] : []),
        ]}
        configModes={[
          ...(workspaceMode === 'code' ? [{ id: 'plan', icon: FileText, label: t('promptInput.modes.plan'), active: plan, onToggle: () => setModeActive('plan', sessionId, !plan) }] : []),
          { id: 'vision', icon: Eye, label: t('promptInput.modes.vision'), active: vision, onToggle: () => toggleMode('vision'), onConfigure: () => { setPlusOpen(false); setVisionConfigOpen(true) } },
          { id: 'subagents', icon: Bot, label: t('promptInput.modes.subagents'), active: subagents, onToggle: () => setModeActive('subagents', sessionId, !subagents), onConfigure: () => { setPlusOpen(false); setWorkerConfigOpen(true) } },
          ...(workspaceMode === 'code' ? [{ id: 'orchestra', icon: Network, label: t('promptInput.modes.orchestra'), active: orchestra, onToggle: () => setModeActive('orchestra', sessionId, !orchestra), onConfigure: () => { setPlusOpen(false); setWorkerConfigOpen(true) } }] : []),
          { id: 'loop', icon: RefreshCw, label: t('promptInput.modes.loop'), active: loop, onToggle: () => setLoop((v) => !v), onConfigure: () => { setPlusOpen(false); setLoopConfigOpen(true) } },
        ]}
        displayMode={displayMode}
      />

      <ConfigSheet
        visible={configOpen}
        onClose={() => setConfigOpen(false)}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        thinking={thinking}
        onThinkingToggle={() => update({ enabled: !enabled, variantId })}
        reasoningVariants={model?.variants ?? []}
        reasoningSelected={variantId}
        onReasoningSelect={(id) => update({ enabled: true, variantId: id })}
        reasoningAlwaysOn={model?.reasoningAlwaysOn}
        subagents={subagents}
        onSubagentsToggle={() => setModeActive('subagents', sessionId, !subagents)}
        orchestra={orchestra}
        onOrchestraToggle={() => setModeActive('orchestra', sessionId, !orchestra)}
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
        displayMode={displayMode}
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

function AdvancedToggle({ icon: Icon, active, onPress, tokens }: { icon: React.ComponentType<{ size?: number; color?: string }>; active: boolean; onPress: () => void; tokens: any }) {
  return (
    <Pressable onPress={onPress} className="p-1.5 rounded-md" style={active ? { backgroundColor: tokens.muted } : { opacity: 0.4 }}>
      <Icon size={15} color={active ? tokens.primary : tokens.mutedForeground} />
    </Pressable>
  )
}

// Folha que assina o modo workspace sozinha — só ela re-renderiza quando a aba
// chat/código troca, sem cascata para o PromptInput (que é memo-seguro).
const AdvancedModesRow = memo(function AdvancedModesRow({
  plan,
  subagents,
  orchestra,
  loop,
  onTogglePlan,
  onToggleSubagents,
  onToggleOrchestra,
  onToggleLoop,
  tokens,
}: {
  plan: boolean
  subagents: boolean
  orchestra: boolean
  loop: boolean
  onTogglePlan: () => void
  onToggleSubagents: () => void
  onToggleOrchestra: () => void
  onToggleLoop: () => void
  tokens: any
}) {
  const workspaceMode = useWorkspaceStore((s) => s.mode)
  if (workspaceMode === 'code') {
    return (
      <View className="flex-row items-center gap-2" style={{ borderLeftWidth: 1, borderLeftColor: tokens.border, paddingLeft: 6 }}>
        <AdvancedToggle icon={FileText} active={plan} onPress={onTogglePlan} tokens={tokens} />
        <AdvancedToggle icon={Bot} active={subagents} onPress={onToggleSubagents} tokens={tokens} />
        <AdvancedToggle icon={Network} active={orchestra} onPress={onToggleOrchestra} tokens={tokens} />
        <AdvancedToggle icon={RefreshCw} active={loop} onPress={onToggleLoop} tokens={tokens} />
      </View>
    )
  }
  return (
    <View className="flex-row items-center gap-2" style={{ borderLeftWidth: 1, borderLeftColor: tokens.border, paddingLeft: 6 }}>
      <AdvancedToggle icon={Bot} active={subagents} onPress={onToggleSubagents} tokens={tokens} />
      <AdvancedToggle icon={RefreshCw} active={loop} onPress={onToggleLoop} tokens={tokens} />
    </View>
  )
})

// Folha que move o useSlashCommands (que assina o modo) para fora do corpo do
// PromptInput: ao trocar a aba, só este shell re-renderiza e recomputa os
// comandos — o PromptInput fica intacto (memo do ChatInput segura).
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
    <SlashPalette value={value} setText={setText} commands={commands}>
      {children}
    </SlashPalette>
  )
})
