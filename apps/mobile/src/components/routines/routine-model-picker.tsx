import { useState } from 'react'
import { Text, Pressable, View } from 'react-native'
import { ChevronDown, Brain } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { RoutineModel } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { ModelPickerModal } from '~/components/chat/ModelPickerModal'
import { ProviderLogo } from '~/components/ui/provider-logo'

/**
 * Routine model picker — the model is stored ON the routine (not per session),
 * so the picker is value/onChange, unlike the chat's ModelPicker. The model
 * modal is the same, only with the owner's selection callback.
 */
export function RoutineModelPicker({
  value,
  onChange,
}: {
  value: RoutineModel | null
  onChange: (model: RoutineModel | null) => void
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
          <ProviderLogo providerId={value.providerId} size={14} color={tokens.mutedForeground} />
        ) : (
          <Brain size={14} color={tokens.mutedForeground} />
        )}
        <Text className="max-w-[160px] text-sm font-medium" numberOfLines={1} style={{ color: tokens.mutedForeground }}>
          {info?.name ?? value?.modelId ?? t('routines.create.noModel')}
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
