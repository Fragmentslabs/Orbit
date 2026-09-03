import { useCallback, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, Switch, StyleSheet } from 'react-native'
import { X, Search, Check, Sparkles, Brain } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { CatalogModelList } from './CatalogModelList'
import type { ModelVariant } from '@orbit/shared'

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
  // Fechado não monta nada. Antes o componente vivia junto do PromptInput e
  // recalculava o catálogo a cada render dele, mesmo com o modal fora da tela.
  if (!visible) return null
  return <WorkerModelSheet onClose={onClose} />
}

function WorkerModelSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)
  const workerModel = useSettingsStore((s) => s.workerModel)
  const workerReasoning = useSettingsStore((s) => s.workerReasoning)

  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  // Pelos setters do store, não por setState + Storage na mão: são eles que
  // persistem E empurram a config para o desktop (worker-config:set). Escrever
  // direto no store deixava a escolha só neste aparelho.
  const setWorkerModel = useSettingsStore((s) => s.setWorkerModel)
  const setWorkerReasoning = useSettingsStore((s) => s.setWorkerReasoning)

  const toggleReasoning = (on: boolean) => {
    void setWorkerReasoning(on ? { enabled: true } : null)
  }

  const selectVariant = (variantId: string) => {
    void setWorkerReasoning({ enabled: true, variantId })
  }

  const [search, setSearch] = useState('')

  const handleSelect = useCallback(
    (providerId: string, modelId: string) => {
      void setWorkerModel({ providerId, modelId })
    },
    [setWorkerModel],
  )

  const selectedCatalogModel = workerModel && catalog
    ? catalog[workerModel.providerId]?.models[workerModel.modelId]
    : undefined
  const thinkingOn = workerReasoning?.enabled ?? false
  const supportsReasoning = selectedCatalogModel?.reasoning && !selectedCatalogModel?.reasoningAlwaysOn
  const variants = selectedCatalogModel?.variants ?? []

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        <View style={[s.sheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View style={s.header}>
            <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('workerModelModal.title')}</Text>
            <Pressable onPress={onClose} style={s.closeBtn}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <Text style={[s.headerDesc, { color: tokens.mutedForeground }]}>
            {t('workerModelModal.description')}
          </Text>

          {/* Usar o modelo do chat */}
          <Pressable
            onPress={() => {
              void setWorkerModel(null)
              void setWorkerReasoning(null)
            }}
            style={[s.sameModelRow, { borderColor: tokens.border }, !workerModel && { backgroundColor: rowSelectedBg }]}
          >
            <Sparkles size={16} color={tokens.primary} />
            <Text style={[s.sameModelText, { color: tokens.foreground }]}>{t('workerModelModal.useSameModel')}</Text>
            {!workerModel && <Check size={16} color={tokens.primary} />}
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

          <CatalogModelList
            search={search}
            selected={workerModel}
            onSelect={handleSelect}
            emptyLabel={t('workerModelModal.noModels')}
            header={
              /* Config de thinking rola junto com a lista, como antes */
              workerModel && supportsReasoning ? (
                <View style={[s.thinkingCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
                  <View style={s.thinkingRow}>
                    <View className="flex-row items-center gap-2">
                      <Brain size={18} color={tokens.mutedForeground} />
                      <Text style={[s.thinkingLabel, { color: tokens.foreground }]}>{t('workerModelModal.thinkingOnWorker')}</Text>
                    </View>
                    <Switch
                      value={thinkingOn}
                      onValueChange={toggleReasoning}
                      trackColor={{ false: tokens.muted, true: tokens.primary }}
                      thumbColor={tokens.foreground}
                    />
                  </View>
                  {thinkingOn && variants.length > 0 && (
                    <View style={s.reasoningLevels}>
                      {variants.map((v: ModelVariant) => {
                        const active = v.id === (workerReasoning?.variantId ?? '')
                        return (
                          <Pressable
                            key={v.id}
                            onPress={() => selectVariant(v.id)}
                            style={[
                              s.levelChip,
                              active
                                ? { backgroundColor: tokens.background, borderColor: tokens.border }
                                : { backgroundColor: tokens.muted, borderColor: tokens.border },
                            ]}
                          >
                            <Text
                              style={[
                                s.levelChipLabel,
                                { color: active ? tokens.primary : tokens.mutedForeground },
                              ]}
                            >
                              {v.label}
                            </Text>
                            {active && <Check size={14} color={tokens.primary} />}
                          </Pressable>
                        )
                      })}
                    </View>
                  )}
                </View>
              ) : undefined
            }
          />
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
  thinkingCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  thinkingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  thinkingLabel: { fontSize: 13, fontWeight: '500' },
  reasoningLevels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  levelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
  },
  levelChipLabel: { fontSize: 13, fontWeight: '500' },
})
