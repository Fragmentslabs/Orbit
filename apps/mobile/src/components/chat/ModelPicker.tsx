import { useState } from 'react'
import { Text, Pressable } from 'react-native'
import { ChevronDown, Brain } from 'lucide-react-native'
import { useSettingsStore } from '~/stores/settings-store'
import { useSessionModel } from '~/stores/session-model-prefs'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { ModelPickerModal } from './ModelPickerModal'
import { ProviderLogo } from '~/components/ui/provider-logo'

export function ModelPicker({ sessionId }: { sessionId?: string | null }) {
  const [modalVisible, setModalVisible] = useState(false)
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const catalog = useSettingsStore((s) => s.catalog)
  // Modelo da sessão (override por chat > último chat > default global) —
  // mesmo comportamento do picker do desktop.
  const selected = useSessionModel(sessionId)

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
        {selected?.providerId ? (
          <ProviderLogo providerId={selected.providerId} size={14} color={tokens.mutedForeground} />
        ) : (
          <Brain size={14} className="text-muted-foreground" />
        )}
        <Text className="text-sm text-muted-foreground font-medium max-w-[120px]" numberOfLines={1}>
          {selectedModelInfo?.name ?? selected?.modelId ?? 'Selecionar Modelo'}
        </Text>
        <ChevronDown size={12} className="text-muted-foreground" />
      </Pressable>
      <ModelPickerModal visible={modalVisible} onClose={() => setModalVisible(false)} sessionId={sessionId} />
    </>
  )
}
