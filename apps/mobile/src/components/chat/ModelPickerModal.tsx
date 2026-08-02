import { useState, useMemo } from 'react'
import { Modal, View, Text, TextInput, Pressable, ScrollView, Platform } from 'react-native'
import { X, Search, Check, Brain, RefreshCw } from 'lucide-react-native'
import { Image } from 'expo-image'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '~/stores/settings-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { hslToRgba } from '~/lib/theme'
import { Spin } from '~/components/ui/spin'
import { cn } from '~/lib/utils'

interface ModelPickerModalProps {
  visible: boolean
  onClose: () => void
}

function ModelRowSkeleton({ tokens }: { tokens: Record<string, string> }) {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3.5">
      <View className="h-4 w-4 rounded-full" style={{ backgroundColor: tokens.muted }} />
      <View className="flex-1 gap-1.5">
        <View className="h-3 w-32 rounded" style={{ backgroundColor: tokens.muted }} />
        <View className="h-2.5 w-20 rounded" style={{ backgroundColor: tokens.muted }} />
      </View>
    </View>
  )
}

export function ModelPickerModal({ visible, onClose }: ModelPickerModalProps) {
  const { t } = useTranslation()
  const catalog = useSettingsStore((s) => s.catalog)
  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const selectModel = useSettingsStore((s) => s.selectModel)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const loading = useSettingsStore((s) => s.loading)
  const fetchCatalog = useSettingsStore((s) => s.fetchCatalog)

  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const [search, setSearch] = useState('')

  const isWeb = Platform.OS === 'web'
  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  const groups = useMemo(() => {
    if (!catalog) return []

    const q = search.toLowerCase().trim()

    return Object.values(catalog)
      .filter((provider) => connectedProviders.includes(provider.id))
      .map((provider) => {
        const filteredModels = Object.values(provider.models).filter((model) => {
          if (!q) return true
          return (
            model.name.toLowerCase().includes(q) ||
            model.id.toLowerCase().includes(q) ||
            provider.name.toLowerCase().includes(q)
          )
        })

        return {
          provider,
          models: filteredModels.sort((a, b) => {
            if (a.release_date && b.release_date) {
              return b.release_date.localeCompare(a.release_date)
            }
            return a.name.localeCompare(b.name)
          }),
        }
      })
      .filter((group) => group.models.length > 0)
  }, [catalog, search, connectedProviders])

  const handleSelect = async (providerId: string, modelId: string) => {
    await selectModel(providerId, modelId)
    onClose()
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isWeb ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <View
        className={cn(
          "flex-1",
          isWeb ? "justify-center items-center p-4" : "justify-end"
        )}
        style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      >
        {/* Backdrop press to close */}
        <Pressable className="absolute inset-0" onPress={onClose} />

        {/* Modal/Drawer Container */}
        <View
          className={cn(
            "shadow-2xl overflow-hidden",
            isWeb
              ? "w-full max-w-md h-[550px] rounded-2xl"
              : "w-full h-[80%] rounded-t-3xl"
          )}
          style={{ backgroundColor: tokens.background, borderColor: tokens.border, borderWidth: isWeb ? 1 : 0 }}
        >
          {/* Mobile top handle indicator */}
          {!isWeb && (
            <View className="items-center py-2">
              <View className="w-10 h-1.5 rounded-full" style={{ backgroundColor: hslToRgba(tokens.mutedForeground.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), 0.3) }} />
            </View>
          )}

          {/* Header */}
          <View className="flex-row items-center justify-between px-4 py-3.5" style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: tokens.foreground }}>{t('modelPickerModal.title')}</Text>
            <Pressable onPress={onClose} className="p-1 rounded-md" style={({ pressed }) => pressed ? { backgroundColor: tokens.muted } : undefined}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>

          {/* Search */}
          <View className="px-4 py-2 mt-1 flex-row items-center gap-2">
            <View className="flex-1 flex-row items-center gap-2 px-3 py-1.5 rounded-lg" style={{ backgroundColor: tokens.muted }}>
              <Search size={16} color={tokens.mutedForeground} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder={t('modelPickerModal.searchPlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                className="flex-1 text-sm py-0.5"
                style={{ color: tokens.foreground }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {search.length > 0 && (
                <Pressable onPress={() => setSearch('')} className="p-0.5">
                  <X size={14} color={tokens.mutedForeground} />
                </Pressable>
              )}
            </View>
            <Pressable
              onPress={() => void fetchCatalog()}
              disabled={loading}
              className="h-9 w-9 items-center justify-center rounded-lg"
              style={{ backgroundColor: tokens.muted }}
            >
              <Spin active={loading}>
                <RefreshCw size={16} color={tokens.mutedForeground} />
              </Spin>
            </Pressable>
          </View>

          {/* Catalog List */}
          <ScrollView className="flex-1 px-4 mt-2" showsVerticalScrollIndicator={isWeb}>
            {groups.length === 0 && loading ? (
              <View className="gap-1">
                <ModelRowSkeleton tokens={tokens} />
                <ModelRowSkeleton tokens={tokens} />
                <ModelRowSkeleton tokens={tokens} />
                <ModelRowSkeleton tokens={tokens} />
              </View>
            ) : groups.length === 0 ? (
              <View className="py-12 items-center">
                <Text className="text-sm mb-1 text-center font-medium" style={{ color: tokens.mutedForeground }}>{t('modelPickerModal.noModelsAvailable')}</Text>
                <Text className="text-xs text-center px-4 leading-relaxed" style={{ color: tokens.mutedForeground, opacity: 0.75 }}>
                  {connectedProviders.length === 0
                    ? t('modelPickerModal.configureProviderHint')
                    : t('modelPickerModal.trySearchHint')}
                </Text>
              </View>
            ) : (
              groups.map(({ provider, models }) => (
                <View key={provider.id} className="mb-4">
                  {/* Provider Header */}
                  <Text className="text-xs font-semibold uppercase tracking-wider mb-2 mt-1 pl-1" style={{ color: tokens.mutedForeground }}>
                    {provider.name}
                  </Text>

                  {/* Models List */}
                  <View className="rounded-xl overflow-hidden" style={{ backgroundColor: tokens.card, borderWidth: 1, borderColor: tokens.border }}>
                    {models.map((model, index) => {
                      const isSelected =
                        selectedModel?.providerId === provider.id &&
                        selectedModel?.modelId === model.id

                      return (
                        <Pressable
                          key={model.id}
                          onPress={() => handleSelect(provider.id, model.id)}
                          style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 12,
                            paddingHorizontal: 14,
                            paddingVertical: 11,
                            backgroundColor: isSelected
                              ? rowSelectedBg
                              : pressed
                                ? tokens.muted
                                : 'transparent',
                            borderBottomWidth: index < models.length - 1 ? 1 : 0,
                            borderBottomColor: tokens.border,
                          })}
                        >
                          {/* Provider Logo */}
                          <Image
                            source={`https://models.dev/logos/${provider.id}.svg`}
                            style={{ width: 16, height: 16 }}
                            contentFit="contain"
                            className={resolved === 'dark' ? 'invert' : ''}
                          />

                          {/* Model Info */}
                          <View className="flex-1">
                            <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>{model.name}</Text>
                            <Text className="text-xs" style={{ color: tokens.mutedForeground }} numberOfLines={1}>
                              {model.id}
                            </Text>
                          </View>

                          {/* Indicators */}
                          {model.reasoning && (
                            <Brain size={14} color={tokens.mutedForeground} style={{ marginRight: 4 }} />
                          )}

                          {isSelected && <Check size={16} color={tokens.primary} />}
                        </Pressable>
                      )
                    })}
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
