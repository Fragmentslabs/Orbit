import { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Globe, Monitor } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { hostLabel, isBusy } from '~/lib/live-logic'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { selectActiveSurfaces, useLiveStore } from '~/stores/live-store'
import { useThemeStore } from '~/stores/theme-store'

/**
 * "Agent is using the browser / computer" chip above the message field — the phone's
 * counterpart of the desktop's computer chip. It only exists while the desktop reports the
 * surface open, and opens the live screen.
 */
export function LiveChips({ sessionId }: { sessionId: string | undefined }) {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const states = useLiveStore((s) => s.states)
  const surfaces = useMemo(() => selectActiveSurfaces(states, sessionId), [states, sessionId])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (surfaces.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(timer)
  }, [surfaces.length])

  if (!sessionId || surfaces.length === 0) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginBottom: 8 }}>
      {surfaces.map((surface) => {
        const Icon = surface.kind === 'computer' ? Monitor : Globe
        const busy = isBusy(surface, now)
        const label =
          surface.kind === 'computer'
            ? t('live.chipComputer', { app: surface.app ?? '' })
            : t('live.chipBrowser', { host: hostLabel(surface.url).split('/')[0] || t('live.browserTitle') })
        return (
          <Pressable
            key={surface.kind}
            onPress={() => router.push({ pathname: '/live', params: { sessionId, kind: surface.kind } })}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              maxWidth: '100%',
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: busy ? tokens.primary : tokens.border,
              backgroundColor: pressed ? tokens.muted : withAlpha(tokens.primary, busy ? 0.08 : 0),
            })}
          >
            <Icon size={14} color={busy ? tokens.primary : tokens.mutedForeground} />
            <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, fontWeight: '600', color: tokens.foreground }}>{label}</Text>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: busy ? tokens.success : tokens.mutedForeground }} />
          </Pressable>
        )
      })}
    </View>
  )
}
