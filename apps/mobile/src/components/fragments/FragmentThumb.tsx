import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import type { FragmentPhoneEntry } from '@orbit/shared'
import { FragmentIcon } from './FragmentIcon'
import { tint } from '~/components/list/parts'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * The cover of a card: a picture of the page, taken by the desktop once per revision and theme. It is a plain
 * image, so the phone keeps it on disk — the address changes with the token, so the cache is keyed by what the
 * picture IS (fragment, revision, theme): a rewrite of the page is a new picture, the same page is never fetched
 * twice. The icon tile stays under it until the picture arrives, and stays for good when it cannot be taken.
 */
export function FragmentThumb({ entry, width, height }: { entry: FragmentPhoneEntry; width: number; height: number }) {
  const resolved = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(resolved)
  const cacheKey = `fragment-cover:${entry.id}:${entry.revision}:${resolved}`
  // A cover that failed is remembered by its key, so a new revision tries again.
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const folder = entry.url.endsWith('/') ? entry.url : `${entry.url}/`

  return (
    <View style={[s.box, { width, height, backgroundColor: tokens.muted }]}>
      <View style={s.fill}>
        <View style={[s.tile, { backgroundColor: tint(tokens.primary, '2e') }]}>
          <FragmentIcon name={entry.icon} size={26} color={tokens.foreground} />
        </View>
      </View>
      {failedKey === cacheKey ? null : (
        <Image
          source={{ uri: `${folder}__orbit-cover-${resolved}.png`, cacheKey }}
          cachePolicy="disk"
          contentFit="cover"
          contentPosition="top"
          transition={200}
          recyclingKey={cacheKey}
          onError={() => setFailedKey(cacheKey)}
          style={s.fill}
        />
      )}
    </View>
  )
}

const s = StyleSheet.create({
  box: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  tile: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
})
