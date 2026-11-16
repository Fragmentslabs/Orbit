/**
 * Folders screen — the project folders of the desktop the phone knows about: where its chats
 * work, its pipeline projects and the recent picks. Add one by browsing the desktop (through the
 * companion's directory listing), rename or remove it from the phone (the desktop disk is never
 * touched), see its chats, start a new chat in it, analyze it (/init) and publish it to GitHub.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, FlatList, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Folder, FolderSearch, FolderPlus, GitBranch, CloudUpload, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react-native'
import type { FolderGitInfoResponse } from '@orbit/shared'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { CountLine, FootLine, HeaderButton, ListHeader, ListRow, SearchField, useTokens } from '~/components/list/parts'
import { DirBrowserModal } from '~/components/chat/FolderSelector'
import { PublishRepoSheet } from '~/components/folders/PublishRepoSheet'
import { RenamePrompt } from '~/components/ui/rename-prompt'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useKnownFolders } from '~/hooks/useKnownFolders'
import { chatsInFolder, normalizePath, type KnownFolder } from '~/lib/known-folders'
import { saveRecentFolder } from '~/lib/folder-recents'
import { canPublishRepo } from '~/lib/init-project'
import { useConnectionStore } from '~/stores/connection-store'
import { useDraftFolders } from '~/stores/draft-folders-store'
import { useFolderPrefs } from '~/stores/folder-prefs-store'
import { useInitProjectStore } from '~/stores/init-project-store'
import { useSessionStore } from '~/stores/session-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { formatWhenShort } from '~/lib/format-time'

export default function FoldersScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const known = useKnownFolders()
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? known.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)) : known
  }, [known, query])

  const selected = selectedPath ? known.find((f) => f.path === selectedPath) : undefined

  const handlePicked = useCallback((path: string) => {
    setAdding(false)
    const normalized = normalizePath(path)
    useFolderPrefs.getState().unhide(normalized)
    void saveRecentFolder(normalized)
    // The recents of the selector feed the list, so the new folder shows up without a chat in it.
    const draft = useDraftFolders.getState()
    draft.setFolders([normalized, ...draft.folders.filter((f) => normalizePath(f) !== normalized)])
    setSelectedPath(normalized)
  }, [])

  return (
    <SafeScreen>
      <ListHeader
        title={selected ? selected.name : t('folders.title')}
        subtitle={selected ? undefined : t('folders.subtitle')}
        onBack={() => (selected ? setSelectedPath(null) : router.back())}
        right={selected ? undefined : <HeaderButton icon={FolderPlus} label={t('folders.add')} onPress={() => setAdding(true)} />}
      />

      {selected ? (
        <FolderDetail folder={selected} onGone={() => setSelectedPath(null)} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(f) => f.path}
          ListHeaderComponent={
            <View style={{ paddingHorizontal: 12, paddingTop: 10, gap: 4 }}>
              <SearchField value={query} onChange={setQuery} placeholder={t('folders.search')} />
              <CountLine>{t('folders.count', { count: filtered.length })}</CountLine>
            </View>
          }
          renderItem={({ item }) => (
            <ListRow
              tile={
                <View style={[s.tile, { backgroundColor: tokens.muted }]}>
                  <Folder size={19} color={tokens.primary} />
                </View>
              }
              title={item.name}
              lines={[
                { text: item.path },
                { text: item.chatCount > 0 ? t('folders.chats', { count: item.chatCount }) : t('folders.noChats'), quiet: true },
              ]}
              onPress={() => setSelectedPath(item.path)}
            />
          )}
          ListEmptyComponent={<Text style={[s.empty, { color: tokens.mutedForeground }]}>{t('folders.empty')}</Text>}
          ListFooterComponent={<FootLine icon={Folder} text={t('folders.foot')} />}
          contentContainerStyle={{ paddingBottom: 24 }}
        />
      )}

      <DirBrowserModal visible={adding} onClose={() => setAdding(false)} onPick={handlePicked} />
    </SafeScreen>
  )
}

function FolderDetail({ folder, onGone }: { folder: KnownFolder; onGone: () => void }) {
  const { t, i18n } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const confirm = useConfirm()
  const wsClient = useConnectionStore((s) => s.wsClient)
  const sessions = useSessionStore((s) => s.sessions)
  const chats = useMemo(() => chatsInFolder(sessions, folder.path), [sessions, folder.path])
  const key = normalizePath(folder.path)
  const initialized = useInitProjectStore((s) => s.initialized[key])
  const [git, setGit] = useState<FolderGitInfoResponse | null>(null)
  const [loadingGit, setLoadingGit] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [published, setPublished] = useState<string | null>(null)

  // `gitTick` re-reads the folder after publishing it.
  const [gitTick, setGitTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    wsClient
      .send({ type: 'folders:git-info', directory: folder.path })
      .then((res) => {
        if (!cancelled) setGit(res.ok ? (res.data as FolderGitInfoResponse) : null)
      })
      .catch(() => {
        if (!cancelled) setGit(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingGit(false)
      })
    return () => {
      cancelled = true
    }
  }, [wsClient, folder.path, gitTick])

  useEffect(() => {
    void useInitProjectStore.getState().hydrate()
    void useInitProjectStore.getState().check(folder.path)
  }, [folder.path])

  const newChatHere = () => {
    const draft = useDraftFolders.getState()
    draft.setFolders([folder.path])
    draft.setPendingFolder(null)
    useWorkspaceStore.getState().setMode('code')
    void saveRecentFolder(folder.path)
    router.push('/(main)')
  }

  const analyze = async () => {
    if (analyzing) return
    setAnalyzing(true)
    try {
      const store = useSessionStore.getState()
      const session = await store.createSession('code')
      if (!session) return
      useInitProjectStore.getState().dismiss(folder.path)
      await store.sendMessage('/init', { sessionId: session.id, directory: folder.path, options: { initMode: true } })
      router.push({ pathname: '/(main)/chat/[id]', params: { id: session.id } })
    } finally {
      setAnalyzing(false)
    }
  }

  const remove = async () => {
    const ok = await confirm({
      title: t('folders.removeTitle'),
      description: t('folders.removeBody', { name: folder.name }),
      confirmLabel: t('folders.remove'),
      cancelLabel: t('folders.cancel'),
      destructive: true,
    })
    if (!ok) return
    useFolderPrefs.getState().hide(folder.path)
    onGone()
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 32 }}>
      <Text style={[s.path, { color: tokens.mutedForeground }]} selectable>
        {folder.path}
      </Text>

      <View style={s.gitLine}>
        <GitBranch size={14} color={tokens.mutedForeground} />
        {loadingGit ? (
          <ActivityIndicator size="small" color={tokens.primary} />
        ) : (
          <Text style={{ fontSize: 12.5, color: tokens.mutedForeground, flex: 1 }} numberOfLines={2}>
            {!git?.exists
              ? t('folders.git.missing')
              : !git.isRepo
                ? t('folders.git.notRepo')
                : [git.branch || t('folders.git.detached'), git.remoteUrl ?? t('folders.git.noRemote')].join(' · ')}
          </Text>
        )}
      </View>
      {published ? <Text style={{ fontSize: 12.5, color: tokens.primary }}>{t('folders.published', { name: published })}</Text> : null}

      <Action icon={MessageSquarePlus} label={t('folders.newChat')} onPress={newChatHere} />
      {initialized === false ? <Action icon={FolderSearch} label={t('folders.analyze')} onPress={() => void analyze()} busy={analyzing} /> : null}
      {canPublishRepo(git) ? <Action icon={CloudUpload} label={t('folders.publish')} onPress={() => setPublishing(true)} /> : null}
      <Action icon={Pencil} label={t('folders.rename')} onPress={() => setRenaming(true)} />
      <Action icon={Trash2} label={t('folders.remove')} onPress={() => void remove()} danger />

      <CountLine>{chats.length > 0 ? t('folders.chats', { count: chats.length }) : t('folders.noChats')}</CountLine>
      {chats.map((c) => (
        <ListRow
          key={c.id}
          tile={<View style={[s.tile, { backgroundColor: tokens.muted }]}><Folder size={17} color={tokens.mutedForeground} /></View>}
          title={c.title}
          lines={[{ text: formatWhenShort(c.updatedAt, i18n.language), quiet: true }]}
          onPress={() => router.push({ pathname: '/(main)/chat/[id]', params: { id: c.id } })}
        />
      ))}

      <RenamePrompt
        visible={renaming}
        title={t('folders.rename')}
        initialValue={folder.name}
        onClose={() => setRenaming(false)}
        onSubmit={(name) => useFolderPrefs.getState().rename(folder.path, name)}
      />
      <PublishRepoSheet
        open={publishing}
        directory={folder.path}
        onClose={() => setPublishing(false)}
        onCreated={(r) => {
          setPublished(r.fullName)
          setGitTick((n) => n + 1)
        }}
      />
    </ScrollView>
  )
}

function Action({ icon: Icon, label, onPress, danger, busy }: { icon: typeof Folder; label: string; onPress: () => void; danger?: boolean; busy?: boolean }) {
  const tokens = useTokens()
  return (
    <Pressable onPress={onPress} disabled={busy} style={({ pressed }) => [s.action, { borderColor: tokens.border }, pressed && { backgroundColor: tokens.accent }]} accessibilityRole="button">
      {busy ? <ActivityIndicator size="small" color={tokens.primary} /> : <Icon size={18} color={danger ? tokens.destructive : tokens.mutedForeground} />}
      <Text style={[s.actionText, { color: danger ? tokens.destructive : tokens.foreground }]}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', paddingVertical: 40, paddingHorizontal: 24, fontSize: 14 },
  path: { fontSize: 12.5 },
  gitLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, height: 48 },
  actionText: { fontSize: 14.5, fontWeight: '500' },
})
