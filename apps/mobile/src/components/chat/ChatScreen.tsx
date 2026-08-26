import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { View, Text, Animated } from 'react-native'
import { useTranslation } from 'react-i18next'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { SafeScreen } from '~/components/layout/SafeScreen'
import type { SendMessageOptions, FilePart } from '@orbit/shared'
import { folderKey, normalizeFolderName } from '@orbit/shared'
import { PlanReviewCard } from '~/components/chat/PlanReviewCard'
import { TaskProgress } from '~/components/chat/TaskProgress'
import { OrchestrationPlanCard } from '~/components/chat/OrchestrationPlanCard'
import { useSessionStore } from '~/stores/session-store'
import { useChatStore } from '~/stores/chat-store'
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
import { Persona } from '~/components/ai/Persona'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'
import { useShallow } from 'zustand/react/shallow'
import { startMessageScheduler, useMessageQueueStore } from '~/stores/message-queue-store'
import { Storage } from '~/lib/storage'

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
  /** ID da sessão existente. Ausente = rascunho de conversa nova. */
  sessionId?: string
}

// Referência estável para o seletor do zustand (evita loop de getSnapshot)
const NO_MESSAGES: never[] = []

export function ChatScreen({ sessionId }: ChatScreenProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const mode = useWorkspaceStore((s) => s.mode)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const session = useSessionStore(
    useShallow((s) => s.sessions.find((sess) => sess.id === sessionId))
  )
  // Seletores estreitos: assinar o mapa inteiro re-renderizava a tela toda a
  // cada delta de QUALQUER sessão (e o mapa muda de identidade em todo set).
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
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const replyToAsk = useChatStore((s) => s.replyToAsk)

  const isStreaming = activeStatus === 'streaming' || activeStatus === 'submitted'
  const activeAsks = sessionId ? pendingAsks[sessionId] ?? [] : []
  const isEmpty = activeMessages.length === 0

  const messageListRef = useRef<MessageListHandle>(null)
  const chatSearchOpen = useChatSearchStore((s) => s.open)
  const closeChatSearch = useChatSearchStore((s) => s.close)

  // Persona: grande no centro quando vazio, some assim que a conversa começa.
  const chatProgress = useRef(new Animated.Value(isEmpty ? 0 : 1)).current
  // Persona pequena do header: só aparece depois que a do centro termina de
  // sumir (mesma lógica em duas etapas do desktop) — por isso o delay igual
  // à duração da animação do centro.
  const headerPersonaOpacity = useRef(new Animated.Value(isEmpty ? 0 : 1)).current

  useEffect(() => {
    Animated.timing(chatProgress, {
      toValue: isEmpty ? 0 : 1,
      duration: 400,
      useNativeDriver: true,
    }).start()

    if (isEmpty) {
      headerPersonaOpacity.setValue(0)
    } else {
      Animated.timing(headerPersonaOpacity, {
        toValue: 1,
        duration: 300,
        delay: 400,
        useNativeDriver: true,
      }).start()
    }
  }, [isEmpty, chatProgress, headerPersonaOpacity])

  useEffect(() => {
    void selectSession(sessionId ?? null)
    closeChatSearch()
  }, [sessionId])

  useEffect(() => {
    startMessageScheduler()
  }, [])

  useEffect(() => {
    if (!sessionId) return
    return useSessionStore.subscribe((state) => {
      const status = state.status[sessionId]
      if (status === 'idle' || status === 'error') {
        useMessageQueueStore.getState().onSessionIdle(sessionId)
      }
    })
  }, [sessionId])

  // Cria a sessão no primeiro envio quando ainda é um rascunho (sem id).
  const [creating, setCreating] = useState(false)

  // Pastas do modo código: rascunho começa vazio; sessão existente herda as
  // pastas dela (e mudanças são persistidas no próximo envio).
  const [folders, setFolders] = useState<string[]>([])
  // Ref espelho das pastas, atualizado no setter (não no render): o handleSend
  // fica com identidade estável entre trocas de modo — senão o memo do
  // ChatInput quebra e o PromptInput inteiro re-renderiza (o delay da troca).
  const foldersRef = useRef<string[]>([])
  const updateFolders = useCallback((next: string[]) => {
    foldersRef.current = next
    setFolders(next)
  }, [])
  useEffect(() => {
    if (session?.directory) {
      updateFolders([session.directory, ...(session.extraDirectories ?? [])])
    }
  }, [session?.directory, session?.extraDirectories, updateFolders])

  const isCode = (session?.mode ?? mode) === 'code'

  // Sugestões do estado vazio — traduzidas e por modo, como no desktop
  const chatSuggestions = t('chatScreen.suggestions.chat', { returnObjects: true }) as string[]
  const codeSuggestions = t('chatScreen.suggestions.code', { returnObjects: true }) as string[]
  const suggestions = isCode ? codeSuggestions : chatSuggestions

  const handleSend = useCallback(
    async (text: string, options?: SendMessageOptions, files?: FilePart[]) => {
      // Modo lido na hora do envio (getState) + pastas via ref: nada disso
      // entra nas deps, então o handleSend não muda quando a aba troca.
      const target = sessionId
        ? useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        : undefined
      const codeMode = (target?.mode ?? useWorkspaceStore.getState().mode) === 'code'
      const dirConfig = codeMode && foldersRef.current.length > 0
        ? { directory: foldersRef.current[0], extraDirectories: foldersRef.current.slice(1) }
        : {}
      if (sessionId) {
        sendMessage(text, { options, files, sessionId, ...dirConfig })
        return
      }
      if (creating) return
      setCreating(true)
      try {
        const created = await createSession(useWorkspaceStore.getState().mode)
        if (!created) return

        if (codeMode && foldersRef.current.length > 0 && useSettingsStore.getState().autoCreateFolders) {
          const allFolders = useSessionStore.getState().folders
          const autoFolderMap = await loadAutoFolderMap()
          const existingFolderId = autoFolderMap[foldersRef.current[0]]
          const existingFolder = allFolders.find((f) => f.id === existingFolderId)

          if (existingFolder) {
            // Pasta arquivada não recebe chats novos: o diretório continua
            // mapeado nela e a sessão nasce solta — mesma regra do desktop.
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

        sendMessage(text, { options, files, sessionId: created.id, ...dirConfig })
        router.replace({ pathname: '/(main)/chat/[id]', params: { id: created.id } })
      } finally {
        setCreating(false)
      }
    },
    [sessionId, sendMessage, createSession, router, creating],
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

  const handleUnrevert = useCallback(
    (sid: string) => {
      void unrevert(sid)
    },
    [unrevert],
  )

  const handleDismissRevert = useCallback(
    (_sid: string) => {
      // Apenas esconde a barra localmente — o revert permanece consolidado
    },
    [],
  )

  // Identidades estáveis entre trocas de modo — sem elas o memo do ChatInput
  // quebra e o PromptInput inteiro re-renderiza (o delay da troca de aba).
  const onCreateSession = useCallback(
    () => createSession(useWorkspaceStore.getState().mode),
    [createSession],
  )

  const onNavigateToSession = useCallback(
    (sid: string) => router.replace({ pathname: '/(main)/chat/[id]', params: { id: sid } }),
    [router],
  )

  // Footer da lista memoizado: o MessageList é memo e precisa de props
  // estáveis para não re-renderizar quando o modo troca.
  const listFooter = useMemo<React.ReactElement | undefined>(() => {
    if (planReview && planReview.status === 'proposed') {
      return (
        <View className="px-4 pb-2">
          <PlanReviewCard sessionId={sessionId!} review={planReview} />
        </View>
      )
    }
    if (planReview && planReview.status === 'implementing') {
      return (
        <View className="px-4 pb-2">
          <TaskProgress
            tasks={[{ id: 'plan', title: t('chatScreen.implementPlan'), status: isStreaming ? 'streaming' : 'idle' }]}
            title={t('chatScreen.plan')}
          />
        </View>
      )
    }
    return undefined
  }, [planReview, isStreaming, t, sessionId])

  const handleDelete = useCallback(async () => {
    if (!sessionId) return
    await deleteSession(sessionId)
    router.replace('/(main)')
  }, [sessionId, deleteSession, router])

  const personaState = isEmpty ? 'idle' : isStreaming ? 'thinking' : 'idle'
  const personaVisible = useAppearanceStore((s) => s.personaVisible)

  return (
    <SafeScreen edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* KAV do react-native-keyboard-controller: mesma API do RN, mas a
          animação roda na thread nativa em sincronia com o teclado — sem o
          lag de abrir/fechar do KAV clássico (que só reage no keyboardDidShow/
          Hide). A coluna inteira acompanha: header fixo, conversa encolhe,
          input rente ao teclado. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={insets.top}
      >
        <ChatHeader
          session={session}
          personaState={personaState}
          personaOpacity={headerPersonaOpacity}
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
          {/* Centro: persona grande + título — some assim que a conversa começa */}
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

          {/* Mensagens — aparece assim que a conversa começa */}
          <Animated.View pointerEvents={isEmpty ? 'none' : 'auto'} style={{ flex: 1, opacity: chatProgress }}>
            {!isEmpty && (
              <MessageList
                ref={messageListRef}
                messages={activeMessages}
                isStreaming={isStreaming}
                onRevert={handleRevert}
                onLoadOlder={sessionId ? () => void loadOlderMessages(sessionId) : undefined}
                ListFooterComponent={listFooter}
              />
            )}
          </Animated.View>
        </View>

        {/* Sugestões — ancoradas acima do input, só na conversa vazia */}
        {isEmpty && (
          <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
            <Suggestions suggestions={suggestions} onSelect={handleSuggestion} />
          </View>
        )}

        {/* Modo código: seleção da pasta principal + adicionais (como no desktop) */}
        {isCode && (
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <FolderSelector folders={folders} onFoldersChange={updateFolders} />
          </View>
        )}

        {/* Orquestração — card de aprovação acima do input */}
        {sessionId && orchestration && orchestration.status === 'proposed' && (
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <OrchestrationPlanCard sessionId={sessionId} plan={orchestration} />
          </View>
        )}
        {/* Orquestração — progresso das tarefas em execução/concluído */}
        {sessionId && orchestration && (orchestration.status === 'approved' || orchestration.status === 'running' || orchestration.status === 'done') && (
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <TaskProgress
              tasks={orchestration.tasks.map((task: any) => ({ id: task.id, title: task.title, status: task.status, mode: task.mode }))}
              title={t('chatScreen.orchestration')}
              defaultExpanded={orchestration.status !== 'done'}
            />
          </View>
        )}

        {/* Ask cards — acima do input */}
        {activeAsks.map((ask) => (
          <AskCard key={ask.requestId} ask={ask} onReply={(value) => replyToAsk(ask.requestId, value)} />
        ))}

        {/* Revert ativo: barra com resumo + desfazer */}
        {session?.revert && (
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <RevertBar session={session} onUnrevert={handleUnrevert} onDismiss={handleDismissRevert} />
          </View>
        )}

        {/* Aviso do modo Visão: imagem anexada + modelo sem visão + modo off */}
        {sessionId && <VisionHintCard sessionId={sessionId} />}

        <ChatInput
          onSend={handleSend}
          onAbort={handleAbort}
          isStreaming={isStreaming}
          sessionId={sessionId}
          onCreateSession={onCreateSession}
          onNavigateToSession={onNavigateToSession}
        />
      </KeyboardAvoidingView>
    </SafeScreen>
  )
}
