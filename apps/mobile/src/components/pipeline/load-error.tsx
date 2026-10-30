/**
 * Pipeline loading error state — replaces the endless spinner when fetch()
 * fails (desktop disconnected, old build on the server, timeout...). Shows the
 * technical reason and a retry button.
 */
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { RefreshCw, TriangleAlert } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { usePipelineStore } from '~/stores/pipeline-store'

/**
 * Renders the error state when `loaded` is false and `fetch` failed.
 * Returns `false` when there is no error (so the screens can use a plain `if`).
 */
export function LoadError(): JSX.Element | false {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const error = usePipelineStore((s) => s.error)
  const loading = usePipelineStore((s) => s.loading)
  const fetch = usePipelineStore((s) => s.fetch)

  if (!error) return false

  return (
    <View style={s.box}>
      <TriangleAlert size={30} color={tokens.mutedForeground} style={{ opacity: 0.7 }} />
      <Text style={[s.title, { color: tokens.foreground }]}>{t('pipeline.loadErrorTitle')}</Text>
      <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.loadErrorHint')}</Text>
      <Text style={[s.reason, { color: tokens.mutedForeground }]} numberOfLines={3}>
        {error}
      </Text>
      <Pressable
        onPress={() => void fetch()}
        disabled={loading}
        style={[s.button, { borderColor: tokens.border, opacity: loading ? 0.5 : 1 }]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={tokens.foreground} />
        ) : (
          <RefreshCw size={14} color={tokens.foreground} />
        )}
        <Text style={[s.buttonText, { color: tokens.foreground }]}>{t('pipeline.tryAgain')}</Text>
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  box: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 24,
  },
  title: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  reason: { fontSize: 11, textAlign: 'center', opacity: 0.8 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 6,
  },
  buttonText: { fontSize: 13, fontWeight: '500' },
})
