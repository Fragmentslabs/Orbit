import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { View, Text, Animated, Alert, Pressable } from 'react-native'
import { ArrowDown, HelpCircle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Stack, useRouter } from 'expo-router'
import { SafeScreen } from '~/components/layout/SafeScreen'
import type { ChatMessage, SendMessageOptions, FilePart } from '@orbit/shared'
import { folderKey, normalizeFolderName, replyExcerpt, showsPersonaOnWelcome } from '@orbit/shared'
import { visibleMessageText } from '~/lib/message-utils'
import { useReply } from '~/stores/reply-store'
import { PlanReviewCard } from '~/components/chat/PlanReviewCard'
import { TaskProgress } from '~/components/chat/TaskProgress'
import { OrchestrationPlanCard } from '~/components/chat/OrchestrationPlanCard'
import { sessionModelFor, useSessionStore } from '~/stores/session-store'
import { useChatStore, type PendingAsk } from '~/stores/chat-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useAppearanceStore } from '~/stores/appearance-store'
import { MessageList, type MessageListHandle } from '~/components/chat/MessageList'
import { ChatMessageSearchBar } from '~/components/chat/ChatMessageSearchBar'
import { ChatInput } from '~/components/chat/ChatInput'
import { AskCard } from '~/components/chat/AskCard'
import { VisionHintCard } from '~/components/chat/VisionHintCard'
import { Suggestions } from '~/components/chat/Suggestion'
import { RevertBar } from '~/components/chat/RevertBar'
import { ChatHeader } from '~/components/chat/ChatHeader'
import { FolderSelector } from '~/components/chat/FolderSelector'
import { useDraftFolders } from '~/stores/draft-folders-store'
import { useDraftInput } from '~/stores/draft-input-store'
import { useBottomBreathing } from '~/lib/keyboard'
import { Persona } from '~/components/ai/Persona'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'
import { useShallow } from 'zustand/react/shallow'
import { Storage } from '~/lib/storage'

/** Shared empty list: stable identity for the footer memo. */
const EMPTY_ASKS: PendingAsk[] = []

const AUTO_FOLDER_MAP_KEY = 'orbit_auto_folder_map'

async function loadAutoFolderMap(): Promise<Record<string, string>> {
  try {
    const raw = await Storage.getItem(AUTO_FOLDER_MAP_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function persistAutoFolderMap(map: Record<string, string>): Promise<void> {
  await Storage.setItem(AUTO_FOLDER_MAP_KEY, JSON.stringify(map))
}

interface ChatScreenProps {
  /** ID of the existing session. Absent = draft of a new conversation. */
  sessionId?: string
}

// Stable reference for the zustand selector (avoids a getSnapshot loop)
const NO_MESSAGES: never[] = []

export function ChatScreen({ sessionId }: ChatScreenProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const mode = useWorkspaceStore((s) => s.mode)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const session = useSessionStore(
    useShallow((s) => s.sessions.find((sess) => sess.id === sessionId))
  )
  // Narrow selectors: subscribing to the whole map re-rendered the whole screen on
  // every delta of ANY session (and the map changes identity on every set).
  const activeMessages = useSessionStore((s) =>
    sessionId ? s.messages[sessionId] ?? NO_MESSAGES : NO_MESSAGES,
  )
  const activeStatus = useSessionStore((s) => (sessionId ? s.status[sessionId] : undefined))
  const selectSession = useSessionStore((s) => s.selectSession)
  const loadOlderMessages = useSessionStore((s) => s.loadOlderMessages)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const planReview = useSessionStore((s) => (sessionId ? s.planReviews[sessionId] : undefined))

  const orchestration = useSessionStore((s) => (sessionId ? s.orchestration[sessionId] : undefined))
  const createSession = useSessionStore((s) => s.createSession)
  const abortChat = useSessionStore((s) => s.abortChat)
  const renameSession = useSessionStore((s) => s.renameSession)
  const setPinned = useSessionStore((s) => s.setPinned)
  const setArchived = useSessionStore((s) => s.setArchived)
  const forkSession = useSessionStore((s) => s.forkSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const revertToMessage = useSessionStore((s) => s.revertToMessage)
  const unrevert = useSessionStore((s) => s.unrevert)
  const revertUncertain = useSessionStore((s) => s.revertUncertain)
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const replyToAsk = useChatStore((s) => s.replyToAsk)

  const isStreaming = activeStatus === 'streaming' || activeStatus === 'submitted'
  // Stable reference when there is no request: the list footer is memoized and
  // a new `[]` on every render brought down the memo of MessageList (the whole list
  // reconciled along with any state of the screen).
  const activeAsks = sessionId ? pendingAsks[sessionId] ?? EMPTY_ASKS : EMPTY_ASKS
  const isEmpty = activeMessages.length === 0
  // End of the list visible? Decides whether the pending chip needs to exist.
  const [listAtBottom, setListAtBottom] = useState(true)

  const messageListRef = useRef<MessageListHandle>(null)
  const chatSearchOpen = useChatSearchStore((s) => s.open)
  const closeChatSearch = useChatSearchStore((s) => s.close)

  // Persona: large in the center when empty, it disappears as soon as the conversation starts.
  // useState with a lazy initializer instead of `useRef(new ...).current`:
  // an equally stable value, readable during render (react-hooks/refs forbids reading a
  // ref here) and allocated only once.
  const [chatProgress] = useState(() => new Animated.Value(isEmpty ? 0 : 1))

  useEffect(() => {
    Animated.timing(chatProgress, {
      toValue: isEmpty ? 0 : 1,
      duration: 400,
      useNativeDriver: true,
    }).start()
  }, [isEmpty, chatProgress])

  useEffect(() => {
    void selectSession(sessionId ?? null)
    closeChatSearch()
  }, [sessionId, selectSession, closeChatSearch])

  // Creates the session on the first send when it is still a draft (no id).
  const [creating, setCreating] = useState(false)

  // Folders of code mode: the draft inherits the folder of the last chat (persisted
  // store, like the desktop workspace); the existing session inherits its own
  // (and changes are persisted on the next send).
  const [folders, setFolders] = useState<string[]>(() => useDraftFolders.getState().folders)
  // Mirror ref of the folders, updated in the setter (not during render): handleSend
  // keeps a stable identity across mode switches — otherwise the memo of
  // ChatInput breaks and the whole PromptInput re-renders (the switch delay).
  // It is born with the same value as the state, otherwise the send would see an empty list
  // while the screen shows the inherited folder.
  const foldersRef = useRef<string[]>(useDraftFolders.getState().folders)
  const applyFolders = useCallback((next: string[], persistir: boolean) => {
    foldersRef.current = next
    setFolders(next)
    // Persists as the "most recent folder": the next new chat is already born in it,
    // same pattern as the desktop workspace. An empty list is never persisted —
    // opening a chat conversation (which has no folder) would erase the inheritance.
    if (persistir && next.length > 0) useDraftFolders.getState().setFolders(next)
  }, [])
  // Explicit choice in the selector: that one counts as the most recent folder.
  const updateFolders = useCallback((next: string[]) => applyFolders(next, true), [applyFolders])
  useEffect(() => {
    // Draft (no session) inherits the folder of the last code chat; the existing
    // session rules in the selector, including when it has no folder.
    if (!session) {
      void useDraftFolders.getState().hydrate().then((recentes) => {
        if (recentes.length > 0 && foldersRef.current.length === 0) {
          applyFolders(recentes, false)
        }
      })
      return
    }
    // Fetching/syncing data in an effect is the documented React pattern;
    // the setState the rule flags is the loading/reset marker that
    // MUST happen before the await, otherwise the screen shows stale data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    applyFolders(
      session.directory ? [session.directory, ...(session.extraDirectories ?? [])] : [],
      session.mode === 'code',
    )
  }, [sessionId, session, session?.directory, session?.extraDirectories, applyFolders])

  // The same breathing room that PromptInput applies fixed at the bottom — both need
  // to use the same number so the input touches the keyboard when it opens.
  const respiroDoInput = useBottomBreathing()

  const isCode = (session?.mode ?? mode) === 'code'
  // Code mode without a folder has nothing to work in: the send stays blocked until
  // one is chosen (the text stays editable).
  const needsFolder = isCode && folders.length === 0

  // Suggestions of the empty state — translated and per mode, as on the desktop
  const chatSuggestions = t('chatScreen.suggestions.chat', { returnObjects: true }) as string[]
  const codeSuggestions = t('chatScreen.suggestions.code', { returnObjects: true }) as string[]
  const suggestions = isCode ? codeSuggestions : chatSuggestions

  // The screen can be reused with another id (switching chats in the sidebar)
  // or unmounted while "create chat" is still waiting for the desktop.
  const mountedRef = useRef(true)
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleSend = useCallback(
    async (text: string, options?: SendMessageOptions, files?: FilePart[]) => {
      // Mode read at send time (getState) + folders via ref: none of that
      // goes into the deps, so handleSend does not change when the tab switches.
      const target = sessionId
        ? useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        : undefined
      const codeMode = (target?.mode ?? useWorkspaceStore.getState().mode) === 'code'
      // Without a folder, code mode does not run: the button is already disabled, but the
      // suggestions call the send directly.
      if (codeMode && foldersRef.current.length === 0) return
      const dirConfig = codeMode
        ? { directory: foldersRef.current[0], extraDirectories: foldersRef.current.slice(1) }
        : {}
      if (sessionId) {
        sendMessage(text, { options, files, sessionId, ...dirConfig })
        return
      }
      // The input has already cleared itself when calling the send: any exit without sending
      // gives text and attachments back to the draft, otherwise the message evaporates.
      const devolver = () => useDraftInput.getState().setDraft(null, text, files)
      if (creating) {
        devolver()
        return
      }
      setCreating(true)
      try {
        // Model on screen at the moment of the send. It is pinned into the session by
        // createSession and goes explicitly in the first message: the model chosen for a
        // new chat cannot depend on the adoption order.
        const draftModel = sessionModelFor(null)
        const created = await createSession(useWorkspaceStore.getState().mode)
        if (!created) {
          devolver()
          Alert.alert(t('sessionStore.createFailedTitle'), t('sessionStore.createFailed'))
          return
        }

        // Folder chosen in the "+" of the sidebar takes precedence: it is an explicit
        // decision, it is not to be overwritten with the automatic mapping.
        const { pendingFolderId, setPendingFolder } = useDraftFolders.getState()
        const pendingFolder = pendingFolderId
          ? useSessionStore.getState().folders.find((f) => f.id === pendingFolderId)
          : undefined
        if (pendingFolderId) setPendingFolder(null)

        if (pendingFolder && pendingFolder.mode === created.mode && !pendingFolder.archived) {
          await useSessionStore.getState().moveToFolder(created.id, pendingFolder.id)
        } else if (codeMode && foldersRef.current.length > 0 && useSettingsStore.getState().autoCreateFolders) {
          const allFolders = useSessionStore.getState().folders
          const autoFolderMap = await loadAutoFolderMap()
          const existingFolderId = autoFolderMap[foldersRef.current[0]]
          const existingFolder = allFolders.find((f) => f.id === existingFolderId)

          if (existingFolder) {
            // An archived folder does not receive new chats: the directory stays
            // mapped in it and the session is born loose — same rule as the desktop.
            if (!existingFolder.archived && existingFolder.mode === 'code') {
              await useSessionStore.getState().moveToFolder(created.id, existingFolder.id)
            }
          } else {
            const folderName = normalizeFolderName(foldersRef.current[0])
            const matchingFolder = allFolders.find(
              (f) =>
                f.mode === 'code' &&
                !f.archived &&
                folderKey(f.name) === folderKey(folderName) &&
                !autoFolderMap[foldersRef.current[0]],
            )
            if (matchingFolder) {
              autoFolderMap[foldersRef.current[0]] = matchingFolder.id
              await persistAutoFolderMap(autoFolderMap)
              await useSessionStore.getState().moveToFolder(created.id, matchingFolder.id)
            } else {
              const newFolder = await useSessionStore.getState().createFolder('code', folderName)
              if (newFolder) {
                autoFolderMap[foldersRef.current[0]] = newFolder.id
                await persistAutoFolderMap(autoFolderMap)
                await useSessionStore.getState().moveToFolder(created.id, newFolder.id)
              }
            }
          }
        }

        sendMessage(text, {
          options,
          files,
          sessionId: created.id,
          providerId: draftModel?.providerId,
          modelId: draftModel?.modelId,
          ...dirConfig,
        })
        // It only takes you to the new chat if the person is still in the draft: if they
        // already went to another conversation, pulling them back looked like the message
        // had fallen into the wrong chat.
        if (mountedRef.current && !sessionIdRef.current) {
          router.replace({ pathname: '/(main)/chat/[id]', params: { id: created.id } })
        }
      } finally {
        if (mountedRef.current) setCreating(false)
      }
    },
    [sessionId, sendMessage, createSession, router, creating, t],
  )

  const handleAbort = useCallback(() => {
    if (sessionId) abortChat(sessionId)
  }, [sessionId, abortChat])

  const handleSuggestion = useCallback(
    (suggestion: string) => {
      void handleSend(suggestion)
    },
    [handleSend],
  )

  const handleRename = useCallback(
    (title: string) => {
      if (sessionId) void renameSession(sessionId, title)
    },
    [sessionId, renameSession],
  )

  const handleTogglePin = useCallback(() => {
    if (sessionId && session) void setPinned(sessionId, !session.pinned)
  }, [sessionId, session, setPinned])

  const handleToggleArchive = useCallback(() => {
    if (sessionId && session) {
      void setArchived(sessionId, !session.archived)
      router.replace('/(main)')
    }
  }, [sessionId, session, setArchived, router])

  const handleFork = useCallback(async () => {
    if (!sessionId) return
    const fork = await forkSession(sessionId)
    if (fork) router.replace({ pathname: '/(main)/chat/[id]', params: { id: fork.id } })
  }, [sessionId, forkSession, router])

  const handleRevert = useCallback(
    (messageId: string) => {
      if (sessionId) void revertToMessage(sessionId, messageId)
    },
    [sessionId, revertToMessage],
  )

  const setReply = useReply((s) => s.setReply)

  // Reply: marks the message in the composer (the bar above the text
  // field). The clipping comes out from here — PromptInput only prepends and clears.
  const handleReply = useCallback(
    (message: ChatMessage) => {
      const text = replyExcerpt(visibleMessageText(message))
      if (text) setReply(sessionId, { role: message.role, text })
    },
    [sessionId, setReply],
  )

  // An inline closure here became a new prop on every render and brought down the memo of
  // MessageList — which exists precisely so the list does not reconcile for nothing.
  const handleLoadOlder = useCallback(() => {
    if (sessionId) void loadOlderMessages(sessionId)
  }, [sessionId, loadOlderMessages])

  const handleUnrevert = useCallback(
    (sid: string) => {
      void unrevert(sid)
    },
    [unrevert],
  )

  const handleRevertUncertain = useCallback(
    (sid: string) => {
      void revertUncertain(sid)
    },
    [revertUncertain],
  )

  const handleDismissRevert = useCallback(
    (_sid: string) => {
      // Only hides the bar locally — the revert remains consolidated
    },
    [],
  )

  // Stable identities across mode switches — without them the memo of ChatInput
  // breaks and the whole PromptInput re-renders (the tab switch delay).
  const onCreateSession = useCallback(
    () => createSession(useWorkspaceStore.getState().mode),
    [createSession],
  )

  const onNavigateToSession = useCallback(
    (sid: string) => router.replace({ pathname: '/(main)/chat/[id]', params: { id: sid } }),
    [router],
  )

  // Memoized list footer: MessageList is memo and needs stable props
  // so as not to re-render when the mode switches.
  //
  // This is where the cards of the CONVERSATION live — agent request, revert, plan and
  // progress. Before, they were stacked above the input: each one that
  // showed up shortened the conversation, and with two or three the history vanished from
  // the screen. As an item at the end of the list, they scroll along with the messages.
  // Only the ones that also exist WITHOUT a conversation stay in the bottom band
  // (suggestions, folder, vision notice) — those have no list to enter.
  const revert = session?.revert
  const listFooter = useMemo<React.ReactElement | undefined>(() => {
    const cards: React.ReactElement[] = []
    if (planReview && planReview.status === 'proposed' && sessionId) {
      cards.push(<PlanReviewCard key="plan-review" sessionId={sessionId} review={planReview} />)
    }
    if (planReview && planReview.status === 'implementing') {
      cards.push(
        <TaskProgress
          key="plan-progress"
          tasks={[{ id: 'plan', title: t('chatScreen.implementPlan'), status: isStreaming ? 'streaming' : 'idle' }]}
          title={t('chatScreen.plan')}
        />,
      )
    }
    if (sessionId && orchestration && orchestration.status === 'proposed') {
      cards.push(<OrchestrationPlanCard key="orchestration" sessionId={sessionId} plan={orchestration} />)
    }
    if (
      sessionId &&
      orchestration &&
      (orchestration.status === 'approved' || orchestration.status === 'running' || orchestration.status === 'done')
    ) {
      cards.push(
        <TaskProgress
          key="orchestration-progress"
          tasks={orchestration.tasks.map((task: any) => ({ id: task.id, title: task.title, status: task.status, mode: task.mode }))}
          title={t('chatScreen.orchestration')}
          defaultExpanded={orchestration.status !== 'done'}
        />,
      )
    }
    if (session && revert) {
      cards.push(
        <RevertBar
          key="revert"
          session={session}
          onUnrevert={handleUnrevert}
          onRevertUncertain={handleRevertUncertain}
          onDismiss={handleDismissRevert}
          swipeToDismiss={false}
        />,
      )
    }
    for (const ask of activeAsks) {
      cards.push(
        <AskCard
          key={ask.requestId}
          ask={ask}
          onReply={(value) => replyToAsk(ask.requestId, value)}
          // The list already has paddingHorizontal and the footer already has a gap: the card's
          // own margin would become a double indent and double spacing.
          style={{ marginHorizontal: 0, marginVertical: 0 }}
        />,
      )
    }
    if (cards.length === 0) return undefined
    return <View style={{ gap: 8, paddingTop: 4, paddingBottom: 4 }}>{cards}</View>
  }, [
    planReview,
    isStreaming,
    t,
    sessionId,
    session,
    revert,
    orchestration,
    activeAsks,
    replyToAsk,
    handleUnrevert,
    handleRevertUncertain,
    handleDismissRevert,
  ])

  const handleDelete = useCallback(async () => {
    if (!sessionId) return
    await deleteSession(sessionId)
    router.replace('/(main)')
  }, [sessionId, deleteSession, router])

  // Persona of the welcome screen only: the header shows the name of the chat and the
  // model, with no persona (it used to show up there as soon as the conversation started).
  const personaVisible = showsPersonaOnWelcome(useAppearanceStore((s) => s.personaVisibility))

  // The bottom inset does NOT enter SafeScreen: with the keyboard open it was left over
  // between the input and the keyboard (the KAV already pushes the whole column). Whoever applies
  // the bottom breathing room is PromptInput, which knows whether the keyboard is open.
  return (
    <SafeScreen edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* KAV of react-native-keyboard-controller: same API as RN, but the
          animation runs on the native thread in sync with the keyboard — without the
          open/close lag of the classic KAV (which only reacts on keyboardDidShow/
          Hide). The whole column follows: fixed header, the conversation shrinks,
          input flush with the keyboard.

          The lib calculates the padding as `bottom of the frame - (screen height -
          keyboard - offset)`, and the frame is already offset by the paddingTop of
          SafeScreen — passing the top inset as offset added the notch height to
          the keyboard space. The NEGATIVE offset here discounts the breathing room
          that the input applies fixed at the bottom: so the animated padding counts as
          `keyboard - breathingRoom`, the total matches at both extremes and there is only ONE
          animation (two went out of phase and made the input overshoot). */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={-respiroDoInput}
      >
        <ChatHeader
          session={session}
          onRename={handleRename}
          onTogglePin={handleTogglePin}
          onToggleArchive={handleToggleArchive}
          onFork={handleFork}
          onDelete={handleDelete}
          searchEnabled={!isCode}
        />

        {chatSearchOpen && !isCode && !isEmpty && (
          <ChatMessageSearchBar
            messages={activeMessages}
            onJumpToMessage={(id) => messageListRef.current?.scrollToMessageId(id)}
          />
        )}

        <View style={{ flex: 1 }}>
          {/* Center: large persona + title — disappears as soon as the conversation starts */}
          <Animated.View
            pointerEvents={isEmpty ? 'auto' : 'none'}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 24,
              opacity: chatProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              transform: [{ scale: chatProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.85] }) }],
            }}
          >
            {personaVisible && <Persona state="idle" size={112} />}
            <View style={{ marginTop: 16, alignItems: 'center', gap: 4 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', color: tokens.foreground }}>{t('chatScreen.newConversationTitle')}</Text>
              <Text style={{ fontSize: 14, color: tokens.mutedForeground }}>{t('chatScreen.newConversationSubtitle')}</Text>
            </View>
          </Animated.View>

          {/* Messages — show up as soon as the conversation starts */}
          <Animated.View pointerEvents={isEmpty ? 'none' : 'auto'} style={{ flex: 1, opacity: chatProgress }}>
            {!isEmpty && (
              <MessageList
                ref={messageListRef}
                messages={activeMessages}
                isStreaming={isStreaming}
                onRevert={handleRevert}
                onReply={handleReply}
                onLoadOlder={handleLoadOlder}
                ListFooterComponent={listFooter}
                onAtBottomChange={setListAtBottom}
              />
            )}
          </Animated.View>
        </View>

        {/* Suggestions — anchored above the input, only in the empty conversation */}
        {isEmpty && (
          <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
            <Suggestions suggestions={suggestions} onSelect={handleSuggestion} />
          </View>
        )}

        {/* Code mode: selection of the main folder + additional ones (as on the desktop) */}
        {isCode && (
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <FolderSelector folders={folders} onFoldersChange={updateFolders} />
            {needsFolder && (
              <Text style={{ fontSize: 11, marginTop: 6, color: tokens.mutedForeground }}>
                {t('chatScreen.folderRequired')}
              </Text>
            )}
          </View>
        )}

        {/* Pending out of view: the request card is in the conversation (footer
            of the list), and this shortcut takes you to it. It only exists when the person
            scrolled up in the history — with the card in view it would be noise. */}
        {activeAsks.length > 0 && !listAtBottom && (
          <View style={{ paddingHorizontal: 16, marginBottom: 8, alignItems: 'flex-start' }}>
            <Pressable
              onPress={() => messageListRef.current?.scrollToEnd()}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: tokens.primary,
                backgroundColor: pressed ? tokens.muted : 'transparent',
              })}
            >
              <HelpCircle size={14} color={tokens.primary} />
              <Text style={{ fontSize: 12, fontWeight: '600', color: tokens.primary }}>
                {t('chatScreen.pendingAsk', { count: activeAsks.length })}
              </Text>
              <ArrowDown size={14} color={tokens.primary} />
            </Pressable>
          </View>
        )}

        {/* Vision mode notice: image attached + model without vision + mode off.
            It stays in the band because it also exists without a conversation (image pending on
            the initial screen, where there is no list to enter). */}
        {sessionId && <VisionHintCard sessionId={sessionId} />}

        <ChatInput
          onSend={handleSend}
          onAbort={handleAbort}
          isStreaming={isStreaming}
          sessionId={sessionId}
          sendDisabled={needsFolder}
          onCreateSession={onCreateSession}
          onNavigateToSession={onNavigateToSession}
        />
      </KeyboardAvoidingView>
    </SafeScreen>
  )
}
