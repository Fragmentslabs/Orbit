import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { FileDiff, FolderTree, GitBranch, History } from 'lucide-react-native'
import type { GitInfoResponse, WorktreeList } from '@orbit/shared'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ListHeader, useTokens } from '~/components/list/parts'
import { FilesTab } from '~/components/files/FilesTab'
import { BranchSheet } from '~/components/git/BranchSheet'
import { ChangesTab } from '~/components/git/ChangesTab'
import { CommitsTab } from '~/components/git/CommitsTab'
import { RepoBar } from '~/components/git/RepoBar'
import { WorktreeSheet } from '~/components/git/WorktreeSheet'
import { gitInfo, gitInit, gitPull, gitPush, gitStatus, worktreeList } from '~/lib/git-api'
import { syncErrorKey } from '~/lib/git-format'
import { baseName } from '~/lib/files'
import { useSessionStore } from '~/stores/session-store'

type Tab = 'files' | 'changes' | 'commits'

/**
 * The project of a code chat in one screen, like the desktop's panel: Files, Changes (with the
 * commit box) and Commits as tabs, and under the title the worktree and branch pickers plus the
 * pull / push buttons. Without a git repository only the files remain.
 */
export default function ProjectScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const params = useLocalSearchParams<{ sessionId: string; root?: string; tab?: string }>()
  const sessionId = params.sessionId
  const session = useSessionStore((st) => st.sessions.find((x) => x.id === sessionId))

  const [tab, setTab] = useState<Tab>(params.tab === 'changes' || params.tab === 'commits' ? params.tab : 'files')
  // A folder picked here (another worktree, or one of the chat's extra folders) wins over the session's.
  const [rootOverride, setRootOverride] = useState<string | undefined>(params.root || undefined)
  const directory = rootOverride ?? session?.directory
  const [info, setInfo] = useState<GitInfoResponse | null>(null)
  const [changeCount, setChangeCount] = useState(0)
  const insets = useSafeAreaInsets()
  const [worktrees, setWorktrees] = useState<WorktreeList | null>(null)
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [initializing, setInitializing] = useState(false)
  const [syncing, setSyncing] = useState<'pull' | 'push' | null>(null)
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  const [worktreeOpen, setWorktreeOpen] = useState(false)

  const loadRepo = useCallback(async () => {
    if (!directory) return
    try {
      const res = await gitInfo(directory)
      setInfo(res)
      setIsRepo(res.isRepo)
      // A folder without git has no changes, no commits and no worktrees to read.
      if (!res.isRepo) return
    } catch {
      setInfo(null)
      setIsRepo(false)
      return
    }
    // The badge of the Changes tab, read even while another tab is open.
    setChangeCount(await gitStatus(directory).then((r) => r.files.length, () => 0))
    // The list is the label of the worktree pill; a repository without one just hides the pill.
    setWorktrees(await worktreeList(directory).catch(() => null))
  }, [directory])

  useEffect(() => {
    // Reads the repository once the folder is known and again after a switch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRepo()
  }, [loadRepo])

  const refreshAll = useCallback(() => {
    setRefreshKey((n) => n + 1)
    void loadRepo()
  }, [loadRepo])

  const sync = async (op: 'pull' | 'push') => {
    if (!directory || syncing) return
    setSyncing(op)
    setNotice(null)
    try {
      const res = await (op === 'pull' ? gitPull(directory) : gitPush(directory))
      if (res.ok) {
        setNotice({ text: t(op === 'pull' ? 'project.sync.pulled' : res.created ? 'project.sync.pushedNew' : 'project.sync.pushed'), bad: false })
        refreshAll()
      } else {
        setNotice({ text: t(syncErrorKey(op, res)) + (res.kind === 'other' && res.message ? `: ${res.message}` : ''), bad: true })
      }
    } catch (err) {
      setNotice({ text: (err as Error).message, bad: true })
    } finally {
      setSyncing(null)
    }
  }

  const startRepo = async () => {
    if (!directory || initializing) return
    setInitializing(true)
    setNotice(null)
    try {
      await gitInit(directory)
      refreshAll()
    } catch (err) {
      setNotice({ text: (err as Error).message, bad: true })
    } finally {
      setInitializing(false)
    }
  }

  // The notice is a passing line, not a state: it clears itself.
  useEffect(() => {
    if (!notice || notice.bad) return
    const timer = setTimeout(() => setNotice(null), 3000)
    return () => clearTimeout(timer)
  }, [notice])

  const current = worktrees?.worktrees.find((w) => w.path === worktrees.current)
  const worktreeLabel = worktrees ? (!current || current.primary ? t('project.worktree.main') : current.name) : null
  const showGit = isRepo === true && !!directory

  const tabs: { key: Tab; label: string; icon: typeof FolderTree; count?: number }[] = [
    { key: 'files', label: t('project.tabs.files'), icon: FolderTree },
    ...(showGit
      ? [
          { key: 'changes' as const, label: t('project.tabs.changes'), icon: FileDiff, count: changeCount },
          { key: 'commits' as const, label: t('project.tabs.commits'), icon: History },
        ]
      : []),
  ]
  const shown: Tab = showGit ? tab : 'files'

  if (!sessionId || !directory) {
    return (
      <SafeScreen>
        <ListHeader title={t('filesBrowser.title')} onBack={() => router.back()} />
        <Text style={{ color: tokens.mutedForeground, textAlign: 'center', padding: 28 }}>{t('filesBrowser.noFolder')}</Text>
      </SafeScreen>
    )
  }

  return (
    <SafeScreen>
      <ListHeader title={baseName(directory)} subtitle={t('project.subtitle')} onBack={() => router.back()} />
      {showGit && (
        <RepoBar
          info={info}
          worktreeLabel={worktreeLabel}
          syncing={syncing}
          onWorktree={() => setWorktreeOpen(true)}
          onBranch={() => setBranchOpen(true)}
          onPull={() => void sync('pull')}
          onPush={() => void sync('push')}
        />
      )}
      {isRepo === false ? (
        <View style={[st.noGit, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: tokens.foreground }}>{t('project.noGit')}</Text>
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: tokens.mutedForeground }}>{t('project.noGitHint')}</Text>
          </View>
          <Pressable
            onPress={() => void startRepo()}
            disabled={initializing}
            accessibilityRole="button"
            style={[st.initBtn, { backgroundColor: tokens.primary, opacity: initializing ? 0.6 : 1 }]}
          >
            {initializing ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <GitBranch size={15} color={tokens.primaryForeground} />
            )}
            <Text style={{ color: tokens.primaryForeground, fontWeight: '600', fontSize: 13 }}>{t('project.gitInit')}</Text>
          </Pressable>
        </View>
      ) : null}
      {notice ? (
        <Text style={{ fontSize: 12.5, paddingHorizontal: 16, paddingVertical: 6, color: notice.bad ? tokens.destructive : tokens.mutedForeground }}>
          {notice.text}
        </Text>
      ) : null}
      <View style={{ flex: 1 }}>
        {shown === 'files' && (
          <FilesTab key={directory} sessionId={sessionId} root={rootOverride} onRootChange={setRootOverride} refreshKey={refreshKey} />
        )}
        {shown === 'changes' && <ChangesTab key={directory} directory={directory} refreshKey={refreshKey} onChanged={refreshAll} />}
        {shown === 'commits' && <CommitsTab key={directory} directory={directory} refreshKey={refreshKey} />}
      </View>

      {tabs.length > 1 && (
        <View style={[st.bar, { borderTopColor: tokens.border, backgroundColor: tokens.background, paddingBottom: Math.max(insets.bottom, 8) }]}>
          {tabs.map(({ key, label, icon: Icon, count }) => {
            const active = key === shown
            return (
              <Pressable
                key={key}
                onPress={() => setTab(key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={st.tab}
              >
                <View>
                  <Icon size={22} color={active ? tokens.foreground : tokens.mutedForeground} />
                  {count ? (
                    <View style={[st.badge, { backgroundColor: tokens.primary }]}>
                      <Text style={[st.badgeText, { color: tokens.primaryForeground }]}>{count > 99 ? '99+' : count}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[st.tabText, { color: active ? tokens.foreground : tokens.mutedForeground }]}>{label}</Text>
              </Pressable>
            )
          })}
        </View>
      )}

      <BranchSheet
        open={branchOpen}
        directory={directory}
        onClose={() => setBranchOpen(false)}
        onChanged={refreshAll}
      />
      <WorktreeSheet
        open={worktreeOpen}
        folder={directory}
        sessionId={sessionId}
        suggestedName={session?.title}
        onClose={() => setWorktreeOpen(false)}
        onSwitched={(next) => {
          setRootOverride(next)
          setInfo(null)
          setRefreshKey((n) => n + 1)
        }}
      />
    </SafeScreen>
  )
}

const st = StyleSheet.create({
  noGit: { flexDirection: 'row', alignItems: 'center', gap: 12, margin: 12, padding: 12, borderWidth: 1, borderRadius: 14 },
  initBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 12, borderRadius: 10 },
  bar: { flexDirection: 'row', paddingTop: 6, paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, minHeight: 50, alignItems: 'center', justifyContent: 'center', gap: 3 },
  tabText: { fontSize: 11.5, fontWeight: '600' },
  badge: { position: 'absolute', top: -5, right: -11, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 10, fontWeight: '700' },
})
