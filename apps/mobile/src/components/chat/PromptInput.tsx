import { useState, useRef, useCallback, useEffect } from 'react'
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
  X,
  Paperclip,
  ArrowUp,
  Square,
  Settings2,
} from 'lucide-react-native'
import { Image } from 'expo-image'
import type { SendMessageOptions, FilePart, SessionInfo } from '@orbit/shared'
import { resolveSlashAction } from '@orbit/shared'
import { cn } from '~/lib/utils'
import { ContextMeter } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import { AttachmentSheet } from './AttachmentSheet'
import { WorkerModelModal } from './WorkerModelModal'
import { InputAttachment } from './Attachment'
import { ConfigSheet } from './ConfigSheet'
import { SlashPalette } from './SlashPalette'
import { useSlashCommands } from '~/hooks/useSlashCommands'
import { uriToFilePart } from '~/lib/attachments'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useReasoningPrefs } from '~/stores/reasoning-prefs'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SendButtonGroup } from './SendButtonGroup'
import { QueueIndicator } from './QueueIndicator'
import { ScheduleSheet } from './ScheduleSheet'
import { useMessageQueueStore } from '~/stores/message-queue-store'

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
  const [text, setText] = useState('')
  const [activeModes, setActiveModes] = useState<Record<string, boolean>>({
    brain: true,
  })
  const [subagents, setSubagents] = useState(false)
  const [orchestra, setOrchestra] = useState(false)
  const [attachments, setAttachments] = useState<FilePart[]>([])
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [workerConfigOpen, setWorkerConfigOpen] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const workspaceMode = useWorkspaceStore((s) => s.mode)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [permissionMode, setPermissionMode] = useState<'ask' | 'approve' | 'full'>('ask')
  const [scheduleSheetVisible, setScheduleSheetVisible] = useState(false)

  const catalog = useSettingsStore((s) => s.catalog)
  const selected = useSettingsStore((s) => s.selectedModel)
  const model = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]
    : undefined
  const { enabled, variantId, update, hydrate, hydrated } = useReasoningPrefs(selected?.providerId, selected?.modelId)
  const thinking = enabled || !!model?.reasoningAlwaysOn
  const workerModel = useSettingsStore((s) => s.workerModel)
  const workerModelLabel = workerModel && catalog
    ? catalog[workerModel.providerId]?.models[workerModel.modelId]?.name ?? `${workerModel.providerId}/${workerModel.modelId}`
    : null

  useEffect(() => {
    if (!hydrated) hydrate()
  }, [hydrated, hydrate])

  const slashCommands = useSlashCommands()

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
    setActiveModes((prev) => ({ ...prev, [id]: !prev[id] }))
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

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || disabled) return

    const options: SendMessageOptions = {
      research: activeModes.research ?? false,
      browser: activeModes.browser ?? false,
      simple: activeModes.simple ?? false,
      brain: activeModes.brain ?? false,
      reasoning: { enabled: thinking, variantId },
      subagents,
      orchestrate: orchestra ? {} : undefined,
      permissionMode: workspaceMode === 'code' ? permissionMode : undefined,
    }

    // Comandos "/" viram o prompt do pipeline correspondente
    const resolved = resolveSlashAction(trimmed, workspaceMode)
    const finalText = resolved?.prompt ?? trimmed

    onSend(finalText, options, attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
    setPlusOpen(false)
  }, [text, isStreaming, disabled, onSend, activeModes, subagents, orchestra, attachments, workspaceMode, permissionMode, thinking, variantId])

  const buildOptions = useCallback(() => {
    return {
      research: activeModes.research ?? false,
      browser: activeModes.browser ?? false,
      simple: activeModes.simple ?? false,
      brain: activeModes.brain ?? false,
      reasoning: { enabled: thinking, variantId },
      subagents,
      orchestrate: orchestra ? {} : undefined,
      permissionMode: workspaceMode === 'code' ? permissionMode : undefined,
    } satisfies SendMessageOptions
  }, [activeModes, thinking, variantId, subagents, orchestra, workspaceMode, permissionMode])

  const enqueueForSend = useMessageQueueStore((s) => s.enqueueForSend)
  const enqueueScheduled = useMessageQueueStore((s) => s.enqueueScheduled)

  const handleQueue = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId) return
    const resolved = resolveSlashAction(trimmed, workspaceMode)
    enqueueForSend(sessionId, resolved?.prompt ?? trimmed, buildOptions(), workspaceMode)
    setText('')
    setAttachments([])
  }, [text, sessionId, enqueueForSend, buildOptions, workspaceMode])

  const handleStopAndSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId) return
    const resolved = resolveSlashAction(trimmed, workspaceMode)
    onAbort()
    enqueueForSend(sessionId, resolved?.prompt ?? trimmed, buildOptions(), workspaceMode)
    setText('')
    setAttachments([])
  }, [text, sessionId, onAbort, enqueueForSend, buildOptions, workspaceMode])

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

      const resolved = resolveSlashAction(trimmed, workspaceMode)
      enqueueScheduled(sid, resolved?.prompt ?? trimmed, buildOptions(), workspaceMode, timestamp)
      setText('')
      setAttachments([])
    },
    [text, sessionId, onCreateSession, onNavigateToSession, enqueueScheduled, buildOptions, workspaceMode],
  )

  const modesList = [
    { id: 'research', icon: Search, label: 'Pesquisa' },
    { id: 'browser', icon: Globe, label: 'Browser' },
    { id: 'simple', icon: AlignLeft, label: 'Simples' },
    { id: 'brain', icon: BrainCircuit, label: 'Memória' },
  ]

  const toggleSheetMode = useCallback((id: string) => {
    if (id === 'subagents') return setSubagents((prev) => !prev)
    if (id === 'orchestra') return setOrchestra((prev) => !prev)
    toggleMode(id)
  }, [toggleMode])

  const sheetModes = modesList.map((mode) => ({ ...mode, active: activeModes[mode.id] ?? false }))

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
      <SlashPalette value={text} setText={setText} commands={slashCommands}>
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
            <Text className="text-xs" style={{ color: tokens.mutedForeground }}>Carregando arquivo...</Text>
          </View>
        )}

        {/* Text Area Input */}
        <View className="flex-row items-end">
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={setText}
            placeholder="Pergunte qualquer coisa..."
            placeholderTextColor={tokens.mutedForeground}
            multiline
            maxLength={4096}
            editable={!isStreaming && !disabled}
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

        {/* Footer Row */}
        <View className="flex-row items-center justify-between pt-1.5 pb-1 mt-1"
          style={{ borderTopWidth: 1, borderTopColor: tokens.border }}
        >
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
            {/* Status Indicators */}
            {subagents && <Bot size={15} color={tokens.primary} />}
            {orchestra && <Network size={15} color={tokens.primary} />}

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
      </SlashPalette>

      {/* Mode Toggles Row */}
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
            const isActive = activeModes[mode.id] ?? false
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
        modes={sheetModes}
        onToggleMode={toggleSheetMode}
        subagents={subagents}
        orchestra={orchestra}
        onConfigureWorkers={() => {
          setPlusOpen(false)
          setWorkerConfigOpen(true)
        }}
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
        onSubagentsToggle={() => setSubagents((prev) => !prev)}
        orchestra={orchestra}
        onOrchestraToggle={() => setOrchestra((prev) => !prev)}
        workerModelLabel={workerModelLabel}
        onConfigureWorkers={() => {
          setConfigOpen(false)
          setWorkerConfigOpen(true)
        }}
      />

      <WorkerModelModal visible={workerConfigOpen} onClose={() => setWorkerConfigOpen(false)} />
      <ScheduleSheet
        visible={scheduleSheetVisible}
        onClose={() => setScheduleSheetVisible(false)}
        onConfirm={handleScheduleConfirm}
      />
    </View>
  )
}
