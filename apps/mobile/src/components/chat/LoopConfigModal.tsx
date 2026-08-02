import { useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, Switch, StyleSheet, ScrollView } from 'react-native'
import { X, RefreshCw } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSettingsStore, type LoopConfig } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface LoopConfigModalProps {
  visible: boolean
  onClose: () => void
}

export function LoopConfigModal({ visible, onClose }: LoopConfigModalProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const savedConfig = useSettingsStore((s) => s.loopConfig)
  const setLoopConfig = useSettingsStore((s) => s.setLoopConfig)

  const [maxIterations, setMaxIterations] = useState(String(savedConfig.maxIterations))
  const [autoReview, setAutoReview] = useState(savedConfig.autoReview)

  const handleSave = async () => {
    const config: LoopConfig = {
      maxIterations: Math.max(1, Math.min(10, Number(maxIterations) || 3)),
      autoReview,
    }
    await setLoopConfig(config)
    onClose()
  }

  const handleClose = () => {
    setMaxIterations(String(savedConfig.maxIterations))
    setAutoReview(savedConfig.autoReview)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={s.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />

        <View style={[s.sheet, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View style={s.header}>
            <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('loopConfig.title')}</Text>
            <Pressable onPress={handleClose} style={s.closeBtn}>
              <X size={20} color={tokens.foreground} />
            </Pressable>
          </View>
          <Text style={[s.headerDesc, { color: tokens.mutedForeground }]}>
            {t('loopConfig.description')}
          </Text>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {/* Max Iterations */}
            <View style={[s.card, { borderColor: tokens.border }]}>
              <Text style={[s.cardLabel, { color: tokens.foreground }]}>{t('loopConfig.maxIterations')}</Text>
              <TextInput
                value={maxIterations}
                onChangeText={setMaxIterations}
                keyboardType="number-pad"
                placeholder="3"
                placeholderTextColor={tokens.mutedForeground}
                style={[s.input, { color: tokens.foreground, backgroundColor: tokens.border, borderColor: tokens.muted }]}
              />
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                {t('loopConfig.maxIterationsHint')}
              </Text>
            </View>

            {/* Auto Review */}
            <View style={[s.card, { borderColor: tokens.border }]}>
              <View style={s.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.cardLabel, { color: tokens.foreground }]}>{t('loopConfig.autoReview')}</Text>
                  <Text style={[s.hint, { color: tokens.mutedForeground }]}>
                    {t('loopConfig.autoReviewHint')}
                  </Text>
                </View>
                <Switch
                  value={autoReview}
                  onValueChange={setAutoReview}
                  trackColor={{ false: tokens.muted, true: tokens.primary }}
                  thumbColor={tokens.foreground}
                />
              </View>
            </View>

            {/* Save */}
            <Pressable
              onPress={handleSave}
              style={[s.saveBtn, { backgroundColor: tokens.primary }]}
            >
              <RefreshCw size={16} color="#fff" />
              <Text style={s.saveBtnText}>{t('loopConfig.save')}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    height: '50%',
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
  card: {
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    gap: 10,
    borderWidth: 1,
  },
  cardLabel: { fontSize: 14, fontWeight: '500' },
  hint: { fontSize: 11, opacity: 0.7, lineHeight: 16 },
  input: {
    fontSize: 14,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 4,
  },
  saveBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
})
