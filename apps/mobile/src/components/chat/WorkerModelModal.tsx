import { useMemo, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native'
import { X, Search, Check, Sparkles } from 'lucide-react-native'
import { Image } from 'expo-image'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

interface WorkerModelModalProps {
  visible: boolean
  onClose: () => void
}

/**
 * Configuração do modelo dos workers (subagentes/orquestração) — espelho
 * do modal do desktop: escolhe um modelo do catálogo ou "usar o mesmo
 * modelo do chat" (limpa a configuração).
 */
export function WorkerModelModal({ visible, onClose }: WorkerModelModalProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const workerModel = useSettingsStore((s) => s.workerModel)
  const setWorkerModel = useSettingsStore((s) => s.setWorkerModel)

  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  const [search, setSearch] = useState('')

  const groups = useMemo(() => {
    if (!catalog) return []
    const q = search.toLowerCase().trim()
    return Object.values(catalog)
      .filter((provider) => connectedProviders.includes(provider.id))
      .map((provider) => ({
        provider,
        models: Object.values(provider.models)
          .filter((model) => !q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q))
          .sort((a, b) =>
            a.release_date && b.release_date
              ? b.release_date.localeCompare(a.release_date)
              : a.name.localeCompare(b.name),
          ),
      }))
      .filter((group) => group.models.length > 0)
  }, [catalog, search, connectedProviders])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={[s.sheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View style={s.header}>
            <Text style={[s.headerTitle, { color: tokens.foreground }]}>Modelo dos workers</Text>
            <Pressable onPress={onClose} style={s.closeBtn}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <Text style={[s.headerDesc, { color: tokens.mutedForeground }]}>
            Usado pelos subagentes e pela orquestração. Sem configuração, os workers usam o mesmo modelo do chat.
          </Text>

          {/* Usar o modelo do chat */}
          <Pressable
            onPress={() => {
              void setWorkerModel(null)
              onClose()
            }}
            style={[s.sameModelRow, { borderColor: tokens.border }, !workerModel && { backgroundColor: rowSelectedBg }]}
          >
            <Sparkles size={16} color={tokens.primary} />
            <Text style={[s.sameModelText, { color: tokens.foreground }]}>Usar o mesmo modelo do chat</Text>
            {!workerModel && <Check size={16} color={tokens.primary} />}
          </Pressable>

          {/* Busca */}
          <View style={[s.searchRow, { backgroundColor: tokens.border }]}>
            <Search size={16} color={tokens.mutedForeground} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Pesquisar modelos…"
              placeholderTextColor={tokens.mutedForeground}
              style={[s.searchInput, { color: tokens.foreground }]}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {groups.map(({ provider, models }) => (
              <View key={provider.id} style={{ marginBottom: 16 }}>
                <Text style={[s.providerLabel, { color: tokens.mutedForeground }]}>{provider.name}</Text>
                <View style={[s.modelsBox, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
                  {models.map((model, index) => {
                    const isSelected =
                      workerModel?.providerId === provider.id && workerModel?.modelId === model.id
                    return (
                      <Pressable
                        key={model.id}
                        onPress={() => {
                          void setWorkerModel({ providerId: provider.id, modelId: model.id })
                          onClose()
                        }}
                        style={[
                          s.modelRow,
                          index < models.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.border },
                          isSelected && { backgroundColor: rowSelectedBg },
                        ]}
                      >
                        <Image
                          source={`https://models.dev/logos/${provider.id}.svg`}
                          style={{ width: 16, height: 16 }}
                          contentFit="contain"
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={[s.modelName, { color: tokens.foreground }]}>{model.name}</Text>
                          <Text style={[s.modelId, { color: tokens.mutedForeground }]} numberOfLines={1}>{model.id}</Text>
                        </View>
                        {isSelected && <Check size={16} color={tokens.primary} />}
                      </Pressable>
                    )
                  })}
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    height: '75%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  headerDesc: { fontSize: 12, marginTop: 4, marginBottom: 12, lineHeight: 18 },
  closeBtn: { padding: 4, borderRadius: 8 },
  sameModelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  sameModelText: { flex: 1, fontSize: 14, fontWeight: '500' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 2 },
  providerLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 4 },
  modelsBox: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  modelName: { fontSize: 14, fontWeight: '500' },
  modelId: { fontSize: 11 },
})
