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
import { useAppearanceStore, type ModeId } from '~/stores/appearance-store'
import { useReasoningPrefs } from '~/stores/reasoning-prefs'
import { useModelModePrefs } from '~/stores/model-mode-prefs'
import { useModeActive, useModeOverrides } from '~/stores/mode-overrides'
import { useSimpleMode, useSimplePrefs } from '~/stores/simple-prefs'
import { useBrainEnabled, useBrainPrefs } from '~/stores/brain-prefs'
import { Storage } from '~/lib/storage'
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

// Aviso da primeira vez (workers): modal só abre na 1ª ativação do modo agente
// sem worker configurado; "usar o mesmo modelo do chat" é válido (persistido)
const WORKER_CONFIG_PROMPTED_KEY = 'orbit_worker_config_prompted'

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
  const modesInRow = useAppearanceStore((s) => s.modesInRow)

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

  // Workers: aviso da primeira vez — abre só na 1ª ativação sem worker
  // configurado ("usar o mesmo modelo" é válido); depois nunca mais.
  const [workerConfigPrompted, setWorkerConfigPrompted] = useState(false)

  // Declarado antes do toggleMode porque ele roteia subagents/orchestra para
  // aqui — e ler um ref durante o render nao e permitido.
  const toggleWorkerMode = useCallback((id: 'subagents' | 'orchestra', next: boolean) => {
    setModeActive(id, sessionId, next)
    if (next && !workerModel && !workerConfigPrompted) {
      setWorkerConfigPrompted(true)
      Storage.setItem(WORKER_CONFIG_PROMPTED_KEY, '1').catch(() => {})
      setWorkerConfigOpen(true)
    }
  }, [workerModel, workerConfigPrompted, sessionId, setModeActive])

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
    if (id === 'plan') return setModeActive('plan', sessionId, !plan)
    if (id === 'subagents') return toggleWorkerMode('subagents', !subagents)
    if (id === 'orchestra') return toggleWorkerMode('orchestra', !orchestra)
    if (id === 'loop') return setLoop((v) => !v)
  }, [vision, visionModel, sessionId, search, browser, simple, brain, plan, subagents, orchestra, setModeActive, setSimple, setBrainEnabled, setVisionConfigOpen, setLoop, toggleWorkerMode])

  // Gate de configuração: só abre o modal quando o usuário ATIVA o modo.
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
    enqueueForSend(sessionId, resolved?.prompt ?? trimmed, buildOptions(), modeNow, {
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
    enqueueForSend(sessionId, resolved?.prompt ?? trimmed, buildOptions(), modeNow, {
      files: attachments.length > 0 ? attachments : undefined,
    })
    setText('')
    setAttachments([])
  }, [text, sessionId, onAbort, enqueueForSend, buildOptions, attachments])

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
      enqueueScheduled(sid, resolved?.prompt ?? trimmed, buildOptions(), modeNow, timestamp, {
        files: attachments.length > 0 ? attachments : undefined,
      })
      setText('')
      setAttachments([])
    },
    [text, sessionId, onCreateSession, onNavigateToSession, enqueueScheduled, buildOptions, attachments],
  )

  // Fileira única, na MESMA ordem do code-input do desktop (search, plan,
  // simple, brain, subagents, orchestra, loop, vision). Os avançados eram uma
  // row separada, mas a ordem do desktop os intercala — plan vem antes de
  // simple —, então não dá para manter dois blocos.
  //
  // Browser fica fora do modo código: lá ele nem existe no desktop (o browser
  // do painel direito é outra coisa).
  const isCodeMode = workspaceMode === 'code'
  const modesList = [
    { id: 'research', icon: Search, label: t('promptInput.modes.research') },
    ...(isCodeMode
      ? [{ id: 'plan', icon: FileText, label: t('promptInput.modes.plan'), accent: true }]
      : [{ id: 'browser', icon: Globe, label: t('promptInput.modes.browser') }]),
    { id: 'simple', icon: AlignLeft, label: t('promptInput.modes.simple') },
    { id: 'brain', icon: BrainCircuit, label: t('promptInput.modes.brain') },
    { id: 'subagents', icon: Bot, label: t('promptInput.modes.subagents'), accent: true },
    ...(isCodeMode
      ? [{ id: 'orchestra', icon: Network, label: t('promptInput.modes.orchestra'), accent: true }]
      : []),
    { id: 'loop', icon: RefreshCw, label: t('promptInput.modes.loop'), accent: true },
    { id: 'vision', icon: Eye, label: t('promptInput.modes.vision') },
  ]

  // Mapeia o id da row para o id do modesInRow (espelho do desktop) — a row
  // mostra só os modos marcados nas preferências; o "+" sempre mostra todos.
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

  // Estado efetivo de cada toggle da fileira
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
              disabled={disabled}
            />
          </View>
        </View>
      </View>
      </SlashPaletteShell>

      {/* Mode Toggles Row — sempre visível no mobile (toggles + "+" fixos) */}
      <View className="flex-row items-center justify-between px-1">
        <View className="flex-row items-center gap-2">
          {/* Thinking nao entra aqui: o controle dele (com a escolha de
              variante) ja vive no sheet de configuracoes. */}
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
                  // Avançados (plano, subagentes, orquestra, loop) acendem em
                  // âmbar; os demais em branco — é o que os distingue agora que
                  // dividem a mesma fileira.
                  color={
                    isActive
                      ? mode.accent ? tokens.primary : tokens.foreground
                      : tokens.mutedForeground
                  }
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
        // O corte entre os dois grupos e ter ou nao engrenagem: em cima os
        // toggles secos, embaixo os que abrem configuracao propria. Thinking
        // fica de fora — ele vive no ConfigSheet, onde da para escolher a
        // variante de raciocinio.
        simpleModes={[
          ...(workspaceMode === 'code' ? [{ id: 'plan', icon: FileText, label: t('promptInput.modes.plan'), active: plan, onToggle: () => setModeActive('plan', sessionId, !plan) }] : []),
          { id: 'research', icon: Search, label: t('promptInput.modes.research'), active: search, onToggle: () => toggleMode('research') },
          // Browser so no modo chat, igual a fileira e ao desktop.
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
        onPermissionModeChange={setPermissionMode}
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
