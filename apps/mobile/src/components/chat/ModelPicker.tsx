import { useState } from 'react'
import { Text, Pressable } from 'react-native'
import { ChevronDown, Brain, ListRestart } from 'lucide-react-native'
import { useSettingsStore } from '~/stores/settings-store'
import { useSessionModel } from '~/stores/session-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { ModelPickerModal } from './ModelPickerModal'
import { useSessionRotation } from '~/stores/model-rotation-store'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { useTranslation } from 'react-i18next'

export function ModelPicker({ sessionId }: { sessionId?: string | null }) {
  const { t } = useTranslation()
  const [modalVisible, setModalVisible] = useState(false)
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const catalog = useSettingsStore((s) => s.catalog)
  // Session model (per-chat override > last chat > global default) —
  // same behavior as the desktop picker.
  const selected = useSessionModel(sessionId)
  // Rotation pinned in the chat wins over the model in the trigger — it is the one the engine
  // resolves first (mirror of the desktop trigger).
  const rotation = useSessionRotation(sessionId)

  const selectedModelInfo = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]
    : undefined

  return (
    <>
      <Pressable
        onPress={() => setModalVisible(true)}
        className="flex-row items-center gap-1.5 rounded-md px-2 py-1.5"
        style={({ pressed }) => pressed ? { backgroundColor: tokens.muted } : undefined}
      >
        {rotation ? (
          <ListRestart size={14} color={tokens.mutedForeground} />
        ) : selected?.providerId ? (
          <ProviderLogo providerId={selected.providerId} size={14} color={tokens.mutedForeground} />
        ) : (
          <Brain size={14} className="text-muted-foreground" />
        )}
        <Text className="text-sm text-muted-foreground font-medium max-w-[120px]" numberOfLines={1}>
          {rotation?.name ?? selectedModelInfo?.name ?? selected?.modelId ?? t('modelPicker.select')}
        </Text>
        <ChevronDown size={12} className="text-muted-foreground" />
      </Pressable>
      <ModelPickerModal visible={modalVisible} onClose={() => setModalVisible(false)} sessionId={sessionId} />
    </>
  )
}
