import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, FolderGit2, GitBranch } from 'lucide-react-native'
import type { GitInfoResponse } from '@orbit/shared'
import { useTokens } from '~/components/list/parts'

/**
 * Where the work stands, under the tabs' title: the worktree and the branch (each opens its picker)
 * and the pull / push buttons. The desktop's git panel keeps the same things in its header.
 */
export function RepoBar({
  info,
  worktreeLabel,
  syncing,
  onWorktree,
  onBranch,
  onPull,
  onPush,
}: {
  info: GitInfoResponse | null
  /** Null when the session has no worktree list (nothing to pick). */
  worktreeLabel: string | null
  syncing: 'pull' | 'push' | null
  onWorktree: () => void
  onBranch: () => void
  onPull: () => void
  onPush: () => void
}) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const canSync = !!info?.hasRemote && !syncing
  return (
    <View style={[s.bar, { borderBottomColor: tokens.border }]}>
      <View style={s.pills}>
        {worktreeLabel ? (
          <Pressable
            onPress={onWorktree}
            accessibilityRole="button"
            style={[s.pill, { borderColor: tokens.border, backgroundColor: tokens.card }]}
          >
            <FolderGit2 size={13} color={tokens.mutedForeground} />
            <Text numberOfLines={1} style={[s.pillText, { color: tokens.foreground, maxWidth: 110 }]}>{worktreeLabel}</Text>
            <ChevronDown size={12} color={tokens.mutedForeground} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={onBranch}
          accessibilityRole="button"
          style={[s.pill, { borderColor: tokens.border, backgroundColor: tokens.card, flexShrink: 1 }]}
        >
          <GitBranch size={13} color={tokens.mutedForeground} />
          <Text numberOfLines={1} style={[s.pillText, s.mono, { color: tokens.foreground, flexShrink: 1 }]}>
            {info?.current ?? t('project.detached')}
          </Text>
          <ChevronDown size={12} color={tokens.mutedForeground} />
        </Pressable>
      </View>
      <View style={s.actions}>
        {([
          { op: 'pull', icon: ArrowDownToLine, onPress: onPull, label: t('project.pull') },
          { op: 'push', icon: ArrowUpFromLine, onPress: onPush, label: t('project.push') },
        ] as const).map(({ op, icon: Icon, onPress, label }) => (
          <Pressable
            key={op}
            onPress={onPress}
            disabled={!canSync}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={[s.action, { borderColor: tokens.border, backgroundColor: tokens.card, opacity: canSync || syncing === op ? 1 : 0.4 }]}
          >
            {syncing === op ? <ActivityIndicator size="small" color={tokens.mutedForeground} /> : <Icon size={16} color={tokens.foreground} />}
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  pills: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 10, borderWidth: 1, borderRadius: 99 },
  pillText: { fontSize: 12.5, fontWeight: '600' },
  mono: { fontFamily: 'monospace', fontWeight: '500' },
  actions: { flexDirection: 'row', gap: 6 },
  action: { width: 36, height: 32, borderWidth: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
})
