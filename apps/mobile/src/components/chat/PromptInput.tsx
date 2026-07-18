import { useState, useRef, useCallback } from 'react'
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
} from 'lucide-react-native'
import { Image } from 'expo-image'
import type { SendMessageOptions, FilePart } from '@orbit/shared'
import { cn } from '~/lib/utils'
import { ContextMeter } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import { AttachmentSheet } from './AttachmentSheet'
import { WorkerModelModal } from './WorkerModelModal'
import { InputAttachment } from './Attachment'
import { PermissionModePicker } from './PermissionModePicker'
import { uriToFilePart } from '~/lib/attachments'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface PromptInputProps {
  onSend: (text: string, options: SendMessageOptions, files?: FilePart[]) => void
  onAbort: () => void
  isStreaming?: boolean
  sessionId?: string
  disabled?: boolean
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
  const [workerConfigOpen, setWorkerConfigOpen] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const workspaceMode = useWorkspaceStore((s) => s.mode)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [permissionMode, setPermissionMode] = useState<'ask' | 'approve' | 'full'>('ask')

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
      reasoning: activeModes.thinking ? { enabled: true } : undefined,
      subagents,
      orchestrate: orchestra ? {} : undefined,
      permissionMode: workspaceMode === 'code' ? permissionMode : undefined,
    }

    onSend(trimmed, options, attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
    setPlusOpen(false)
  }, [text, isStreaming, disabled, onSend, activeModes, subagents, orchestra, attachments, workspaceMode, permissionMode])

  const modesList = [
    { id: 'research', icon: Search, label: 'Pesquisa' },
    { id: 'browser', icon: Globe, label: 'Browser' },
    { id: 'thinking', icon: Brain, label: 'Thinking' },
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
    <View className="px-3 py-1.5 relative z-50 overflow-visible"
      style={{ backgroundColor: tokens.background, borderTopWidth: 1, borderTopColor: tokens.border }}
    >
      {/* Attachments & Input border box */}
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
          {/* Plus action button */}
          <TouchableOpacity
            onPress={() => setPlusOpen(true)}
            activeOpacity={0.7}
            className="p-1.5 rounded-md cursor-pointer"
          >
            <Plus size={20} color={tokens.mutedForeground} />
          </TouchableOpacity>

          {/* Model picker & controls */}
          <View className="flex-row items-center gap-2">
            {/* Status Indicators */}
            {subagents && <Bot size={15} color={tokens.primary} />}
            {orchestra && <Network size={15} color={tokens.primary} />}

            {/* Modo de permissão (só no modo código) */}
            {workspaceMode === 'code' && (
              <PermissionModePicker value={permissionMode} onChange={setPermissionMode} />
            )}

            {/* Model Picker */}
            <ModelPicker />

            {/* Send/Stop Button */}
            {isStreaming ? (
              <Pressable
                onPress={onAbort}
                className="h-9 w-9 rounded-full items-center justify-center"
                style={{ backgroundColor: tokens.primary }}
              >
                <Square size={13} color={tokens.primaryForeground} />
              </Pressable>
            ) : (
              <Pressable
                onPress={handleSend}
                disabled={text.trim().length === 0 && attachments.length === 0}
                className={cn(
                  'h-9 w-9 rounded-full items-center justify-center',
                  text.trim().length > 0 || attachments.length > 0 ? '' : 'opacity-40'
                )}
                style={{
                  backgroundColor: text.trim().length > 0 || attachments.length > 0
                    ? tokens.primary : tokens.muted,
                }}
              >
                <ArrowUp size={18} color={tokens.primaryForeground} />
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* Mode Toggles Row */}
      <View className="flex-row items-center justify-between px-1">
        <View className="flex-row items-center gap-2">
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

      <WorkerModelModal visible={workerConfigOpen} onClose={() => setWorkerConfigOpen(false)} />
    </View>
  )
}
