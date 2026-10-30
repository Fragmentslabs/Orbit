import { useCallback, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, StyleSheet } from 'react-native'
import { X, Search, Check, Eye } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { modelSupportsVision } from '@orbit/shared'
import type { CatalogModel, CatalogProvider } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { useModeOverrides } from '~/stores/mode-overrides'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { CatalogModelList } from './CatalogModelList'

interface VisionConfigModalProps {
  visible: boolean
  onClose: () => void
  /** Session (or new chat, undefined) that will have the Vision mode turned on/off. */
  targetSession?: string
}

/**
 * Configuration of the Vision mode — mirror of the desktop VisionConfigDialog:
 * picks the vision model that DESCRIBES images for the agent. It only shows
 * models with image support (modelSupportsVision). Choosing a model
 * configures AND turns the mode on; "Disable vision" clears the selection and turns it off.
 */
export function VisionConfigModal({ visible, onClose, targetSession }: VisionConfigModalProps) {
  // Closed, it mounts nothing (see WorkerModelModal).
  if (!visible) return null
  return <VisionConfigSheet onClose={onClose} targetSession={targetSession} />
}

function VisionConfigSheet({
  onClose,
  targetSession,
}: {
  onClose: () => void
  targetSession?: string
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const visionModel = useSettingsStore((s) => s.visionModel)
  const setVisionModel = useSettingsStore((s) => s.setVisionModel)
  const setModeActive = useModeOverrides((s) => s.setMode)

  const [search, setSearch] = useState('')

  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  // Stable identity: the list uses the filter as a dependency of its memo.
  const visionOnly = useCallback(
    (provider: CatalogProvider, model: CatalogModel) => modelSupportsVision(provider, model.id),
    [],
  )

  const selectModel = useCallback(
    (providerId: string, modelId: string) => {
      // Choosing a model configures AND turns the mode on (in this session), as on the desktop
      void setVisionModel({ providerId, modelId })
      setModeActive('vision', targetSession, true)
    },
    [setVisionModel, setModeActive, targetSession],
  )

  const disableVision = () => {
    void setVisionModel(null)
    setModeActive('vision', targetSession, false)
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
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

          {/* Off — vision mode disabled */}
          <Pressable
            onPress={disableVision}
            style={[s.disabledRow, { borderColor: tokens.border }, !visionModel && { backgroundColor: rowSelectedBg }]}
          >
            <Eye size={16} color={tokens.primary} />
            <Text style={[s.disabledText, { color: tokens.foreground }]}>{t('visionConfig.disabled')}</Text>
            {!visionModel && <Check size={16} color={tokens.primary} />}
          </Pressable>

          {/* Search */}
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
            includeModel={visionOnly}
            selected={visionModel}
            onSelect={selectModel}
            emptyLabel={t('visionConfig.noModels')}
          />
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>
            {t('visionConfig.noSelectionHint')}
          </Text>

          {/* Footer — mirror of the desktop dialog */}
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
