import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Check, Folder, FolderX } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useKnownFolders } from '~/hooks/useKnownFolders'
import { normalizePath } from '~/lib/known-folders'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const MAX_SHOWN = 6

/**
 * Quick choices for the main folder of a chat: the folders the desktop already works in (and the
 * recent ones) plus "no folder". Sits above the directory browser, which stays the way to reach
 * a folder that is not on the list yet.
 */
export function KnownFolderChoices({ current, onPick }: { current?: string; onPick: (path: string | null) => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const known = useKnownFolders().slice(0, MAX_SHOWN)
  const currentKey = current ? normalizePath(current) : null

  return (
    <View>
      <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('folderChoices.known')}</Text>
      {known.map((f) => {
        const active = f.path === currentKey
        return (
          <Pressable key={f.path} onPress={() => onPick(f.path)} style={s.row}>
            <Folder size={18} color={tokens.mutedForeground} />
            <View style={s.text}>
              <Text style={[s.name, { color: tokens.foreground }, active && { fontWeight: '600' }]} numberOfLines={1}>
                {f.name}
              </Text>
              <Text style={[s.path, { color: tokens.mutedForeground }]} numberOfLines={1}>
                {f.path}
              </Text>
            </View>
            {active ? <Check size={16} color={tokens.primary} /> : null}
          </Pressable>
        )
      })}
      <Pressable onPress={() => onPick(null)} style={s.row}>
        <FolderX size={18} color={tokens.mutedForeground} />
        <Text style={[s.name, { color: tokens.foreground, flex: 1 }, !currentKey && { fontWeight: '600' }]}>{t('folderChoices.none')}</Text>
        {!currentKey ? <Check size={16} color={tokens.primary} /> : null}
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  label: { fontSize: 11, letterSpacing: 1, paddingHorizontal: 4, paddingTop: 12, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4, minHeight: 44 },
  text: { flex: 1, minWidth: 0 },
  name: { fontSize: 15 },
  path: { fontSize: 12, marginTop: 1 },
})
