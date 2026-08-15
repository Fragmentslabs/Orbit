import { useState } from 'react'
import { Text, Pressable, View } from 'react-native'
import { ChevronDown, Brain } from 'lucide-react-native'
import { Image } from 'expo-image'
import { useTranslation } from 'react-i18next'
import type { RotinaModelo } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { ModelPickerModal } from '~/components/chat/ModelPickerModal'

/**
 * Seletor de modelo da rotina — o modelo é guardado NA rotina (não por
 * sessão), então o picker é value/onChange, diferente do ModelPicker do chat.
 * O modal de modelos é o mesmo, só com o callback de seleção do dono.
 */
export function RotinaModelPicker({
  value,
  onChange,
}: {
  value: RotinaModelo | null
  onChange: (modelo: RotinaModelo | null) => void
}) {
  const { t } = useTranslation()
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const catalog = useSettingsStore((s) => s.catalog)
  const [modalVisible, setModalVisible] = useState(false)

  const info = value ? catalog?.[value.providerId]?.models[value.modelId] : undefined

  return (
    <View>
      <Pressable
        onPress={() => setModalVisible(true)}
        className="flex-row items-center gap-1.5 self-start rounded-md px-2 py-1.5"
        style={({ pressed }) => (pressed ? { backgroundColor: tokens.muted } : undefined)}
      >
        {value?.providerId ? (
          <Image
            source={`https://models.dev/logos/${value.providerId}.svg`}
            style={{ width: 14, height: 14 }}
            contentFit="contain"
            className={resolved === 'dark' ? 'invert' : ''}
          />
        ) : (
          <Brain size={14} color={tokens.mutedForeground} />
        )}
        <Text className="max-w-[160px] text-sm font-medium" numberOfLines={1} style={{ color: tokens.mutedForeground }}>
          {info?.name ?? value?.modelId ?? t('rotinas.criar.semModelo')}
        </Text>
        <ChevronDown size={12} color={tokens.mutedForeground} />
      </Pressable>
      <ModelPickerModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        selected={value}
        onSelect={(providerId, modelId) => onChange({ providerId, modelId })}
      />
    </View>
  )
}
