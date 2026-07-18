import { useState, useMemo } from 'react'
import { Modal, View, Text, TextInput, Pressable, ScrollView, Platform } from 'react-native'
import { X, Search, Check, Brain, RefreshCw } from 'lucide-react-native'
import { Image } from 'expo-image'
import { useSettingsStore } from '~/stores/settings-store'
import { Spin } from '~/components/ui/spin'
import { cn } from '~/lib/utils'

interface ModelPickerModalProps {
  visible: boolean
  onClose: () => void
}

function ModelRowSkeleton() {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3.5">
      <View className="h-4 w-4 rounded-full bg-muted" />
      <View className="flex-1 gap-1.5">
        <View className="h-3 w-32 rounded bg-muted" />
        <View className="h-2.5 w-20 rounded bg-muted/70" />
      </View>
    </View>
  )
}

export function ModelPickerModal({ visible, onClose }: ModelPickerModalProps) {
  const catalog = useSettingsStore((s) => s.catalog)
  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const selectModel = useSettingsStore((s) => s.selectModel)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const loading = useSettingsStore((s) => s.loading)
  const fetchCatalog = useSettingsStore((s) => s.fetchCatalog)

  const [search, setSearch] = useState('')

  const isWeb = Platform.OS === 'web'

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
          "flex-1 bg-black/60",
          isWeb ? "justify-center items-center p-4" : "justify-end"
        )}
      >
        {/* Backdrop press to close */}
        <Pressable className="absolute inset-0" onPress={onClose} />

        {/* Modal/Drawer Container */}
        <View 
          className={cn(
            "bg-background border border-border/80 shadow-2xl overflow-hidden",
            isWeb 
              ? "w-full max-w-md h-[550px] rounded-2xl" 
              : "w-full h-[80%] rounded-t-3xl border-b-0"
          )}
        >
          {/* Mobile top handle indicator */}
          {!isWeb && (
            <View className="items-center py-2">
              <View className="w-10 h-1.5 rounded-full bg-muted-foreground/30" />
            </View>
          )}

          {/* Header */}
          <View className="flex-row items-center justify-between px-4 py-3.5 border-b border-border/60">
            <Text className="text-base font-semibold text-foreground">Selecionar Modelo</Text>
            <Pressable onPress={onClose} className="p-1 rounded-md active:bg-muted">
              <X size={20} className="text-foreground" />
            </Pressable>
          </View>

          {/* Search */}
          <View className="px-4 py-2 mt-1 flex-row items-center gap-2">
            <View className="flex-1 flex-row items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/60">
              <Search size={16} className="text-muted-foreground" />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Pesquisar modelos…"
                placeholderTextColor="hsl(240, 4%, 46%)"
                className="flex-1 text-sm text-foreground py-0.5"
                autoCapitalize="none"
                autoCorrect={false}
              />
              {search.length > 0 && (
                <Pressable onPress={() => setSearch('')} className="p-0.5">
                  <X size={14} className="text-muted-foreground" />
                </Pressable>
              )}
            </View>
            <Pressable
              onPress={() => void fetchCatalog()}
              disabled={loading}
              className="h-9 w-9 items-center justify-center rounded-lg bg-muted/60 active:bg-muted"
            >
              <Spin active={loading}>
                <RefreshCw size={16} className="text-muted-foreground" />
              </Spin>
            </Pressable>
          </View>

          {/* Catalog List */}
          <ScrollView className="flex-1 px-4 mt-2" showsVerticalScrollIndicator={isWeb}>
            {groups.length === 0 && loading ? (
              <View className="gap-1">
                <ModelRowSkeleton />
                <ModelRowSkeleton />
                <ModelRowSkeleton />
                <ModelRowSkeleton />
              </View>
            ) : groups.length === 0 ? (
              <View className="py-12 items-center">
                <Text className="text-sm text-muted-foreground mb-1 text-center font-medium">Nenhum modelo disponível.</Text>
                <Text className="text-xs text-muted-foreground/75 text-center px-4 leading-relaxed">
                  {connectedProviders.length === 0
                    ? "Por favor, configure as credenciais de um provedor nas configurações do desktop."
                    : "Tente pesquisar por outro nome de modelo."}
                </Text>
              </View>
            ) : (
              groups.map(({ provider, models }) => (
                <View key={provider.id} className="mb-4">
                  {/* Provider Header */}
                  <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-1 pl-1">
                    {provider.name}
                  </Text>

                  {/* Models List */}
                  <View className="border border-border/80 rounded-xl bg-card overflow-hidden">
                    {models.map((model, index) => {
                      const isSelected =
                        selectedModel?.providerId === provider.id &&
                        selectedModel?.modelId === model.id

                      return (
                        <Pressable
                          key={model.id}
                          onPress={() => handleSelect(provider.id, model.id)}
                          className={cn(
                            'flex-row items-center gap-3 px-4 py-3.5',
                            index < models.length - 1 && 'border-b border-border/80',
                            isSelected ? 'bg-accent/40' : 'active:bg-accent/20'
                          )}
                        >
                          {/* Provider Logo */}
                          <Image
                            source={`https://models.dev/logos/${provider.id}.svg`}
                            style={{ width: 16, height: 16 }}
                            contentFit="contain"
                            className="dark:invert"
                          />

                          {/* Model Info */}
                          <View className="flex-1">
                            <Text className="text-sm font-medium text-foreground">{model.name}</Text>
                            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                              {model.id}
                            </Text>
                          </View>

                          {/* Indicators */}
                          {model.reasoning && (
                            <Brain size={14} className="text-muted-foreground mr-1" />
                          )}

                          {isSelected && <Check size={16} className="text-primary" />}
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
