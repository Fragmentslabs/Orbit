import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Check, GitBranch, Plus } from 'lucide-react-native'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { getThemeTokens } from '~/lib/theme-tokens'
import { gitBranches, gitCheckout, gitCreateBranch, gitStatus } from '~/lib/git-api'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Branch selector of the chat header: lists the local branches, switches (asking first when
 * the working tree has changes; git itself refuses when they would be overwritten, and its
 * message is shown, as on the desktop) and creates a branch from the current one.
 */
export function BranchSheet({
  open,
  directory,
  onClose,
  onChanged,
}: {
  open: boolean
  directory?: string
  onClose: () => void
  /** Called with the new current branch after a switch/create. */
  onChanged?: (branch: string) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const tokens = getThemeTokens(useThemeStore((st) => st.resolved))
  const [branches, setBranches] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const load = useCallback(async () => {
    if (!directory) return
    setLoading(true)
    setError(null)
    try {
      const res = await gitBranches(directory)
      setBranches(res.branches)
      setCurrent(res.current)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [directory])

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCreating(false)
    setName('')
    void load()
  }, [open, load])

  const finish = (branch: string) => {
    setCurrent(branch)
    onChanged?.(branch)
    onClose()
  }

  const switchTo = async (branch: string) => {
    if (!directory || branch === current) return onClose()
    setError(null)
    setBusy(branch)
    try {
      const dirty = await gitStatus(directory).then((r) => r.files.length, () => 0)
      if (dirty > 0) {
        const ok = await confirm({
          title: t('branch.confirmTitle', { branch }),
          description: t('branch.confirmDirty', { count: dirty }),
          confirmLabel: t('branch.switch'),
          cancelLabel: t('sidebar.cancel'),
          destructive: true,
        })
        if (!ok) return
      }
      await gitCheckout(directory, branch)
      finish(branch)
    } catch (err) {
      setError((err as Error).message || t('branch.switchError'))
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    const branch = name.trim()
    if (!directory || !branch) return
    setError(null)
    setBusy(branch)
    try {
      await gitCreateBranch(directory, branch)
      finish(branch)
    } catch (err) {
      setError((err as Error).message || t('branch.createError'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={<Text style={[s.title, { color: tokens.foreground }]}>{t('branch.title')}</Text>}
    >
      {error ? <Text style={[s.error, { color: tokens.destructive }]}>{error}</Text> : null}
      {creating ? (
        <View style={s.createRow}>
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('branch.newPlaceholder')}
            placeholderTextColor={tokens.mutedForeground}
            onSubmitEditing={create}
            style={[s.input, { color: tokens.foreground, borderColor: tokens.border, backgroundColor: tokens.background }]}
          />
          <Pressable
            onPress={create}
            disabled={!name.trim() || !!busy}
            style={[s.createBtn, { backgroundColor: tokens.primary, opacity: !name.trim() || busy ? 0.5 : 1 }]}
            accessibilityRole="button"
          >
            {busy ? <ActivityIndicator size="small" color={tokens.primaryForeground} /> : <Text style={{ color: tokens.primaryForeground, fontWeight: '600' }}>{t('branch.create')}</Text>}
          </Pressable>
        </View>
      ) : (
        <Pressable onPress={() => setCreating(true)} style={[s.row, { borderBottomColor: tokens.border }]} accessibilityRole="button">
          <Plus size={16} color={tokens.foreground} />
          <Text style={[s.name, { color: tokens.foreground }]}>{t('branch.newBranch')}</Text>
        </Pressable>
      )}
      {loading ? (
        <ActivityIndicator style={{ margin: 24 }} color={tokens.mutedForeground} />
      ) : (
        <FlatList
          data={branches}
          keyExtractor={(b) => b}
          ListEmptyComponent={<Text style={[s.error, { color: tokens.mutedForeground }]}>{t('branch.none')}</Text>}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => void switchTo(item)}
              disabled={!!busy}
              style={({ pressed }) => [s.row, { borderBottomColor: tokens.border }, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
            >
              <GitBranch size={16} color={tokens.mutedForeground} />
              <Text numberOfLines={1} style={[s.name, { color: tokens.foreground, fontWeight: item === current ? '700' : '500' }]}>{item}</Text>
              {busy === item ? <ActivityIndicator size="small" color={tokens.mutedForeground} /> : item === current ? <Check size={16} color={tokens.foreground} /> : null}
            </Pressable>
          )}
        />
      )}
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '600', paddingBottom: 8 },
  error: { fontSize: 12.5, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { flex: 1, fontSize: 14.5 },
  createRow: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  createBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, minWidth: 70, alignItems: 'center' },
})
