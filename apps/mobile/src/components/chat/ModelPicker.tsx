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
  // Modelo da sessão (override por chat > último chat > default global) —
  // mesmo comportamento do picker do desktop.
  const selected = useSessionModel(sessionId)
  // Rotação pinada no chat vence o modelo no gatilho — é ela que o engine
  // resolve primeiro (espelho do trigger do desktop).
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
