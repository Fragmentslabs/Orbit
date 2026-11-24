import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Bell, Sparkles, X } from 'lucide-react-native'
import type { FragmentPhoneEntry } from '@orbit/shared'
import { describeAccess, pendingCapability } from '~/lib/fragment-permissions'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useFragmentsStore } from '~/stores/fragments-store'
import { useThemeStore } from '~/stores/theme-store'

/**
 * The ask, over the top of the fragment: shown while it wants something (the AI, the internet, MCP tools,
 * notifications) the person has not allowed, one at a time. "Allow" is the person's click; the desktop
 * decides whether it holds (an unreviewed import stays refused). Closing only hides it for now — the
 * permissions sheet still offers it, and the page asking again brings it back.
 */
export function FragmentAskBar({ entry }: { entry: FragmentPhoneEntry }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const grant = useFragmentsStore((s) => s.grant)
  const asks = useFragmentsStore((s) => s.asks[entry.id] ?? 0)
  const pending = pendingCapability(entry)
  // The ask a person dismissed comes back when the page asks again (the counter moves) or the capability changes.
  const [dismissed, setDismissed] = useState<string | null>(null)
  // The capability the desktop refused to grant (an unreviewed import): it says why, instead of a dead button.
  const [refused, setRefused] = useState<string | null>(null)
  const mark = `${pending}:${asks}`

  if (!pending || dismissed === mark) return null
  const Icon = pending === 'notify' ? Bell : Sparkles

  return (
    <View pointerEvents="box-none" style={s.wrap}>
      <View style={[s.bar, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
        <View style={[s.icon, { backgroundColor: tokens.muted }]}>
          <Icon size={15} color={tokens.foreground} />
        </View>
        <Text style={[s.text, { color: tokens.foreground }]} numberOfLines={3}>
          {entry.untrusted || refused === pending
            ? t('fragments.askUntrusted')
            : t(`fragments.ask.${pending}`, { what: describeAccess(entry, pending) })}
        </Text>
        {entry.untrusted || refused === pending ? null : (
          <Pressable
            onPress={() => void grant(entry.id, pending, true).then((ok) => !ok && setRefused(pending))}
            accessibilityRole="button"
            style={[s.allow, { backgroundColor: tokens.primary }]}
          >
            <Text style={{ color: tokens.primaryForeground, fontWeight: '600', fontSize: 12.5 }}>{t('fragments.askAllow')}</Text>
          </Pressable>
        )}
        <Pressable onPress={() => setDismissed(mark)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('fragments.notNow')} style={s.close}>
          <X size={15} color={tokens.mutedForeground} />
        </Pressable>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', top: 10, left: 12, right: 12, alignItems: 'center', zIndex: 10 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 20, paddingVertical: 8, paddingLeft: 8, paddingRight: 6, maxWidth: '100%', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 },
  icon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  text: { flexShrink: 1, fontSize: 12.5, lineHeight: 17 },
  allow: { height: 30, paddingHorizontal: 14, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
})
