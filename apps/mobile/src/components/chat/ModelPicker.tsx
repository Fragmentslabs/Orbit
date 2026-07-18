import { useState } from 'react'
import { Text, Pressable } from 'react-native'
import { ChevronDown, Brain } from 'lucide-react-native'
import { Image } from 'expo-image'
import { useSettingsStore } from '~/stores/settings-store'
import { useThemeStore } from '~/stores/theme-store'
import { ModelPickerModal } from './ModelPickerModal'

export function ModelPicker() {
  const [modalVisible, setModalVisible] = useState(false)
  const resolved = useThemeStore((s) => s.resolved)
  const catalog = useSettingsStore((s) => s.catalog)
  const selected = useSettingsStore((s) => s.selectedModel)

  const selectedModelInfo = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]
    : undefined

  return (
    <>
      <Pressable
        onPress={() => setModalVisible(true)}
        className="flex-row items-center gap-1.5 rounded-md px-2 py-1.5 active:bg-muted"
      >
        {selected?.providerId ? (
          <Image
            source={`https://models.dev/logos/${selected.providerId}.svg`}
            style={{ width: 14, height: 14 }}
            contentFit="contain"
            className={resolved === 'dark' ? 'invert' : ''}
          />
        ) : (
          <Brain size={14} className="text-muted-foreground" />
        )}
        <Text className="text-sm text-muted-foreground font-medium max-w-[120px]" numberOfLines={1}>
          {selectedModelInfo?.name ?? selected?.modelId ?? 'Selecionar Modelo'}
        </Text>
        <ChevronDown size={12} className="text-muted-foreground" />
      </Pressable>
      <ModelPickerModal visible={modalVisible} onClose={() => setModalVisible(false)} />
    </>
  )
}
