import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import type { GitDiffResponse } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { DiffView } from './DiffView'

export interface DiffTarget {
  title: string
  subtitle?: string
  /** Stacked diff of several files: every file collapsible. */
  collapsible?: boolean
  load: () => Promise<GitDiffResponse>
}

/**
 * Full-screen page that draws one patch (a file against HEAD, the whole tree, or what a commit
 * changed in a file). Shared by the Changes and Commits tabs so both open the same diff.
 */
export function DiffModal({ target, onClose }: { target: DiffTarget | null; onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((st) => st.resolved))
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (target_: DiffTarget) => {
    setLoading(true)
    setError(null)
    try {
      const res = await target_.load()
      setPatch({ text: res.patch, truncated: !!res.truncated })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!target) return
    // A new target starts from a blank page: the previous patch must not flash under it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPatch(null)
    void load(target)
  }, [target, load])

  return (
    <Modal visible={!!target} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[s.root, { backgroundColor: tokens.background }]}>
        <View style={[s.header, { borderBottomColor: tokens.border }]}>
          <Pressable onPress={onClose} hitSlop={8} style={s.iconBtn} accessibilityRole="button">
            <ChevronLeft size={22} color={tokens.foreground} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={[s.title, { color: tokens.foreground }]}>{target?.title}</Text>
            {target?.subtitle ? (
              <Text numberOfLines={1} style={[s.sub, { color: tokens.mutedForeground }]}>{target.subtitle}</Text>
            ) : null}
          </View>
          <Pressable
            onPress={() => target && void load(target)}
            hitSlop={8}
            style={s.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={t('changes.refresh')}
          >
            <RefreshCw size={18} color={tokens.mutedForeground} />
          </Pressable>
        </View>
        {loading && !patch ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={tokens.mutedForeground} />
        ) : error ? (
          <Text style={[s.empty, { color: tokens.destructive }]}>{error}</Text>
        ) : patch ? (
          <DiffView
            patch={patch.text}
            collapsible={!!target?.collapsible}
            footer={patch.truncated ? <Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('changes.truncated')}</Text> : undefined}
          />
        ) : null}
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1 },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '600' },
  sub: { fontSize: 11.5 },
  empty: { fontSize: 13, textAlign: 'center', padding: 28 },
})
