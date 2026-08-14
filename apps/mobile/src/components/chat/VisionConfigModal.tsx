import { useMemo, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native'
import { X, Search, Check, Eye } from 'lucide-react-native'
import { Image } from 'expo-image'
import { useTranslation } from 'react-i18next'
import { modelSupportsVision } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { ModalityIcons } from '~/components/ui/modality-icons'

interface VisionConfigModalProps {
  visible: boolean
  onClose: () => void
}

/**
 * Configuração do modo Visão — espelho do VisionConfigDialog do desktop:
 * escolhe o modelo de visão que DESCREVE imagens para o agente. Só mostra
 * modelos com suporte a imagem (modelSupportsVision). Escolher um modelo
 * configura E ativa o modo; "Desativar visão" limpa a seleção e desliga.
 */
export function VisionConfigModal({ visible, onClose }: VisionConfigModalProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const visionModel = useSettingsStore((s) => s.visionModel)
  const setVisionModel = useSettingsStore((s) => s.setVisionModel)
  const setVisionEnabled = useSettingsStore((s) => s.setVisionEnabled)

  const [search, setSearch] = useState('')

  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  const groups = useMemo(() => {
    if (!catalog) return []
    const q = search.toLowerCase().trim()
    return Object.values(catalog)
      .filter((provider) => connectedProviders.includes(provider.id))
      .map((provider) => ({
        provider,
        models: Object.values(provider.models)
          .filter(
            (model) =>
              modelSupportsVision(provider, model.id) &&
              (!q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q)),
          )
          .sort((a, b) =>
            a.release_date && b.release_date
              ? b.release_date.localeCompare(a.release_date)
              : a.name.localeCompare(b.name),
          ),
      }))
      .filter((group) => group.models.length > 0)
  }, [catalog, search, connectedProviders])

  const selectModel = (providerId: string, modelId: string) => {
    // Escolher modelo configura E ativa o modo (como no desktop)
    void setVisionModel({ providerId, modelId })
    void setVisionEnabled(true)
  }

  const disableVision = () => {
    void setVisionModel(null)
    void setVisionEnabled(false)
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={[s.sheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View style={s.header}>
            <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('visionConfig.title')}</Text>
            <Pressable onPress={onClose} style={s.closeBtn}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <Text style={[s.headerDesc, { color: tokens.mutedForeground }]}>
            {t('visionConfig.explainer')}
          </Text>

          {/* Desligado — modo visão desativado */}
          <Pressable
            onPress={disableVision}
            style={[s.disabledRow, { borderColor: tokens.border }, !visionModel && { backgroundColor: rowSelectedBg }]}
          >
            <Eye size={16} color={tokens.primary} />
            <Text style={[s.disabledText, { color: tokens.foreground }]}>{t('visionConfig.disabled')}</Text>
            {!visionModel && <Check size={16} color={tokens.primary} />}
          </Pressable>

          {/* Busca */}
          <View style={[s.searchRow, { backgroundColor: tokens.border }]}>
            <Search size={16} color={tokens.mutedForeground} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t('workerModelModal.searchPlaceholder')}
              placeholderTextColor={tokens.mutedForeground}
              style={[s.searchInput, { color: tokens.foreground }]}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {groups.length === 0 && (
              <Text style={[s.empty, { color: tokens.mutedForeground }]}>
                {t('visionConfig.noModels')}
              </Text>
            )}

            {groups.map(({ provider, models }) => (
              <View key={provider.id} style={{ marginBottom: 16 }}>
                <Text style={[s.providerLabel, { color: tokens.mutedForeground }]}>{provider.name}</Text>
                <View style={[s.modelsBox, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
                  {models.map((model, index) => {
                    const isSelected =
                      visionModel?.providerId === provider.id && visionModel?.modelId === model.id
                    return (
                      <Pressable
                        key={model.id}
                        onPress={() => selectModel(provider.id, model.id)}
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
                        <ModalityIcons modalities={model.modalities?.input} color={tokens.mutedForeground} />
                        {isSelected && <Check size={16} color={tokens.primary} />}
                      </Pressable>
                    )
                  })}
                </View>
              </View>
            ))}

            <Text style={[s.hint, { color: tokens.mutedForeground }]}>
              {t('visionConfig.noSelectionHint')}
            </Text>
          </ScrollView>

          {/* Footer — espelho do dialog desktop */}
          <View style={[s.footer, { borderTopColor: tokens.border }]}>
            {visionModel ? (
              <Pressable onPress={disableVision} style={s.disableBtn}>
                <Text style={[s.disableLabel, { color: tokens.mutedForeground }]}>{t('visionConfig.disable')}</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <Pressable
              onPress={onClose}
              style={[s.doneBtn, { backgroundColor: tokens.primary }]}
            >
              <Text style={[s.doneLabel, { color: tokens.background }]}>{t('visionConfig.done')}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    height: '80%',
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
  disabledRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  disabledText: { flex: 1, fontSize: 14, fontWeight: '500' },
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
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  hint: { fontSize: 11, opacity: 0.7, lineHeight: 16 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: 1,
  },
  disableBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  disableLabel: { fontSize: 13, fontWeight: '500' },
  doneBtn: { borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  doneLabel: { fontSize: 14, fontWeight: '600' },
})
