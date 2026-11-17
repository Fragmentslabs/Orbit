import { Fragment, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Switch } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Check } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { DEFAULT_DICTATION_MODE, useDictationPrefsStore, type DictationMode } from '~/stores/dictation-prefs-store'
import { useVoiceDesktopStore } from '~/stores/voice-desktop-store'
import { nativeSpeechAvailable } from '~/lib/native-speech'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

const MODES: DictationMode[] = ['native', 'desktop']

/** The select for where dictation happens — the phone's recognizer (default) or the desktop's model. */
export default function DictationScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const mode = useDictationPrefsStore((s) => s.mode)
  const setMode = useDictationPrefsStore((s) => s.setMode)
  const callEnabled = useDictationPrefsStore((s) => s.callEnabled)
  const setCallEnabled = useDictationPrefsStore((s) => s.setCallEnabled)
  const desktopLoaded = useVoiceDesktopStore((s) => s.loaded)
  const desktopCall = useVoiceDesktopStore((s) => s.callEnabled)
  const refreshDesktop = useVoiceDesktopStore((s) => s.refresh)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useEffect(() => {
    void refreshDesktop()
  }, [refreshDesktop])
  // A build either has the native module or it does not (the answer is cached).
  const hasNative = nativeSpeechAvailable()

  return (
    <SafeScreen style={s.container}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('dictationScreen.title')}</Text>
        <View style={s.headerBtn} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {MODES.map((id, i) => {
            const selected = mode === id
            return (
              <Fragment key={id}>
                {i > 0 && <View style={[s.divider, { backgroundColor: tokens.border }]} />}
                <Pressable
                  onPress={() => void setMode(id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={s.row}
                >
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={s.titleLine}>
                      <Text
                        style={[
                          s.rowText,
                          { color: selected ? tokens.foreground : tokens.mutedForeground },
                          selected && { fontWeight: '600' },
                        ]}
                      >
                        {t(`dictationScreen.${id}`)}
                      </Text>
                      {id === DEFAULT_DICTATION_MODE ? (
                        <View style={[s.tag, { backgroundColor: tokens.muted }]}>
                          <Text style={[s.tagText, { color: tokens.mutedForeground }]}>{t('dictationScreen.defaultTag')}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t(`dictationScreen.${id}Hint`)}</Text>
                  </View>
                  {selected && <Check size={18} color={tokens.primary} />}
                </Pressable>
              </Fragment>
            )
          })}
        </View>
        <Text style={[s.helperText, { color: tokens.mutedForeground }]}>{t('dictationScreen.description')}</Text>
        {!hasNative ? (
          <Text style={[s.helperText, { color: tokens.destructive }]}>{t('dictationScreen.unavailable')}</Text>
        ) : null}

        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card, marginTop: 20 }]}>
          <View style={s.row}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[s.rowText, { color: tokens.foreground, fontWeight: '600' }]}>{t('dictationScreen.callTitle')}</Text>
              <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('dictationScreen.callHint')}</Text>
            </View>
            <Switch value={callEnabled} onValueChange={(v) => void setCallEnabled(v)} />
          </View>
        </View>
        {desktopLoaded && !desktopCall ? (
          <Text style={[s.helperText, { color: tokens.destructive }]}>{t('dictationScreen.callDesktopOff')}</Text>
        ) : null}
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  divider: { height: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 16 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowText: { fontSize: 14 },
  hint: { fontSize: 12, lineHeight: 17 },
  tag: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  tagText: { fontSize: 10, fontWeight: '600' },
  helperText: { marginTop: 12, fontSize: 11, lineHeight: 16 },
})
