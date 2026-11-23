import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Check, FolderGit2, Plus, Trash2 } from 'lucide-react-native'
import { BASE_REMOTE, type WorktreeInfo, type WorktreeList as WorktreeListData } from '@orbit/shared'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useTokens } from '~/components/list/parts'
import { cleanWorktreeName } from '~/lib/git-format'
import { worktreeCreate, worktreeList, worktreeRemove } from '~/lib/git-api'

/**
 * The worktrees of the chat's repository, like the desktop's selector: which working copy the chat
 * works in. Lists them (the ones made outside Orbit and the pipeline's too), switches, creates one on
 * an `orbit/<name>` branch and removes the ones Orbit may remove. It does not scroll by itself — the
 * sheet or page that hosts it does — and it does not know how a switch is applied: `onSwitch` does
 * (the project screen points the session at the folder; the "+" sheet changes the chat's folders).
 */
export function WorktreeList({
  folder,
  active,
  suggestedName,
  onSwitch,
}: {
  /** The folder the chat works in now (any folder of the repository). */
  folder: string
  /** True while it is on screen: the list is read again every time it turns on. */
  active: boolean
  /** Name proposed for a new worktree (the chat's title). */
  suggestedName?: string
  /** Makes the chat work in this folder; throws with a message the list shows. */
  onSwitch: (folder: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const confirm = useConfirm()
  const [list, setList] = useState<WorktreeListData | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [fromRemote, setFromRemote] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setList(await worktreeList(folder))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [folder])

  useEffect(() => {
    if (!active) return
    // The state (changes, commits ahead) moves while one works: it reloads on every opening.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCreating(false)
    setName('')
    setFromRemote(false)
    void load()
  }, [active, load])

  const switchTo = async (w: WorktreeInfo) => {
    if (!list || w.path === list.current || !w.available) return
    setBusy(w.path)
    setError(null)
    try {
      await onSwitch(w.folder)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    const clean = cleanWorktreeName(name)
    if (!clean) return
    setBusy('new')
    setError(null)
    try {
      const made = await worktreeCreate(folder, clean, fromRemote ? BASE_REMOTE : undefined)
      await onSwitch(made.folder)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (w: WorktreeInfo) => {
    const ok = await confirm({
      title: t('project.worktree.removeTitle', { name: w.name }),
      description: t(w.changes > 0 ? 'project.worktree.removeDirty' : 'project.worktree.removeBody', { count: w.changes }),
      confirmLabel: t('project.worktree.remove'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (!ok) return
    setBusy(w.path)
    setError(null)
    try {
      // From a live folder of the repository: the desktop asks git from there.
      await worktreeRemove(list && w.path === list.current ? list.repo : folder, w.path, false)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <View>
      {error ? <Text style={[s.error, { color: tokens.destructive }]}>{error}</Text> : null}
      {loading && !list ? (
        <ActivityIndicator style={{ margin: 24 }} color={tokens.mutedForeground} />
      ) : !list ? (
        <Text style={[s.error, { color: tokens.mutedForeground }]}>{t('project.worktree.notRepo')}</Text>
      ) : (
        <>
          {list.worktrees.map((w) => {
            const current = w.path === list.current
            const removable = !w.primary && w.origin !== 'pipeline'
            return (
              <View key={w.path} style={[s.row, { borderBottomColor: tokens.border }, !w.available && { opacity: 0.5 }]}>
                <Pressable
                  onPress={() => void switchTo(w)}
                  disabled={!!busy}
                  accessibilityRole="button"
                  style={({ pressed }) => [s.rowMain, pressed && { opacity: 0.6 }]}
                >
                  <FolderGit2 size={17} color={tokens.mutedForeground} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text numberOfLines={1} style={[s.name, { color: tokens.foreground, fontWeight: current ? '700' : '500' }]}>
                      {w.primary ? t('project.worktree.main') : w.name}
                    </Text>
                    <Text numberOfLines={1} style={[s.meta, { color: tokens.mutedForeground }]}>
                      {[
                        w.branch ?? w.head,
                        w.changes > 0 ? t('project.worktree.changes', { count: w.changes }) : null,
                        w.ahead > 0 ? t('project.worktree.ahead', { count: w.ahead }) : null,
                        w.origin === 'pipeline' ? t('project.worktree.pipeline') : null,
                        w.origin === 'external' ? t('project.worktree.external') : null,
                        !w.available ? t('project.worktree.missing') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  {busy === w.path ? (
                    <ActivityIndicator size="small" color={tokens.mutedForeground} />
                  ) : current ? (
                    <Check size={16} color={tokens.foreground} />
                  ) : null}
                </Pressable>
                {removable ? (
                  <Pressable
                    onPress={() => void remove(w)}
                    disabled={!!busy}
                    hitSlop={8}
                    style={s.trash}
                    accessibilityRole="button"
                    accessibilityLabel={t('project.worktree.remove')}
                  >
                    <Trash2 size={16} color={tokens.mutedForeground} />
                  </Pressable>
                ) : null}
              </View>
            )
          })}

          {creating ? (
            <View style={s.createBox}>
              <TextInput
                value={name}
                onChangeText={setName}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('project.worktree.namePlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                onSubmitEditing={() => void create()}
                style={[s.input, { color: tokens.foreground, borderColor: tokens.border, backgroundColor: tokens.background }]}
              />
              {list.defaultRemote ? (
                <View style={s.baseRow}>
                  {[false, true].map((remote) => (
                    <Pressable
                      key={String(remote)}
                      onPress={() => setFromRemote(remote)}
                      style={[s.baseChip, { borderColor: tokens.border, backgroundColor: fromRemote === remote ? tokens.accent : 'transparent' }]}
                    >
                      <Text style={{ fontSize: 12.5, color: tokens.foreground }}>
                        {remote ? t('project.worktree.baseRemote', { remote: list.defaultRemote }) : t('project.worktree.baseCurrent')}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <Pressable
                onPress={() => void create()}
                disabled={!cleanWorktreeName(name) || !!busy}
                accessibilityRole="button"
                style={[s.createBtn, { backgroundColor: tokens.primary, opacity: !cleanWorktreeName(name) || busy ? 0.5 : 1 }]}
              >
                {busy === 'new' ? (
                  <ActivityIndicator size="small" color={tokens.primaryForeground} />
                ) : (
                  <Text style={{ color: tokens.primaryForeground, fontWeight: '600' }}>{t('project.worktree.create')}</Text>
                )}
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => {
                setName(suggestedName ? cleanWorktreeName(suggestedName).toLowerCase().slice(0, 40) : '')
                setCreating(true)
              }}
              style={[s.row, s.rowMain, { borderBottomColor: tokens.border }]}
              accessibilityRole="button"
            >
              <Plus size={17} color={tokens.foreground} />
              <Text style={[s.name, { color: tokens.foreground, flex: 1 }]}>{t('project.worktree.new')}</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  error: { fontSize: 12.5, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  name: { fontSize: 14.5 },
  meta: { fontSize: 11.5 },
  trash: { padding: 8 },
  createBox: { gap: 10, paddingVertical: 12 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  baseRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  baseChip: { borderWidth: 1, borderRadius: 99, paddingHorizontal: 12, height: 32, justifyContent: 'center' },
  createBtn: { height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
})
