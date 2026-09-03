import { useCallback, useState, useEffect, useRef, useMemo } from 'react'
import { View, Text, Animated } from 'react-native'
import { useTranslation } from 'react-i18next'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
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
import { useDraftFolders } from '~/stores/draft-folders-store'
import { useBottomBreathing } from '~/lib/keyboard'
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

  // Pastas do modo código: o rascunho herda a pasta do último chat (store
  // persistido, como o workspace do desktop); a sessão existente herda as dela
  // (e mudanças são persistidas no próximo envio).
  const [folders, setFolders] = useState<string[]>(() => useDraftFolders.getState().folders)
  // Ref espelho das pastas, atualizado no setter (não no render): o handleSend
  // fica com identidade estável entre trocas de modo — senão o memo do
  // ChatInput quebra e o PromptInput inteiro re-renderiza (o delay da troca).
  // Nasce com o mesmo valor do state, senão o envio veria uma lista vazia
  // enquanto a tela mostra a pasta herdada.
  const foldersRef = useRef<string[]>(useDraftFolders.getState().folders)
  const applyFolders = useCallback((next: string[], persistir: boolean) => {
    foldersRef.current = next
    setFolders(next)
    // Persiste como "pasta mais recente": o próximo chat novo já nasce nela,
    // mesmo padrão do workspace do desktop. Lista vazia nunca é persistida —
    // abrir uma conversa de chat (que não tem pasta) apagaria a herança.
    if (persistir && next.length > 0) useDraftFolders.getState().setFolders(next)
  }, [])
  // Escolha explícita no seletor: essa vale como a pasta mais recente.
  const updateFolders = useCallback((next: string[]) => applyFolders(next, true), [applyFolders])
  useEffect(() => {
    // Rascunho (sem sessão) herda a pasta do último chat de código; a sessão
    // existente manda no seletor, inclusive quando não tem pasta.
    if (!session) {
      void useDraftFolders.getState().hydrate().then((recentes) => {
        if (recentes.length > 0 && foldersRef.current.length === 0) {
          applyFolders(recentes, false)
        }
      })
      return
    }
    applyFolders(
      session.directory ? [session.directory, ...(session.extraDirectories ?? [])] : [],
      session.mode === 'code',
    )
  }, [sessionId, session, session?.directory, session?.extraDirectories, applyFolders])

  // O mesmo respiro que o PromptInput aplica fixo embaixo — os dois precisam
  // usar o mesmo número para o input encostar no teclado quando ele abre.
  const respiroDoInput = useBottomBreathing()

  const isCode = (session?.mode ?? mode) === 'code'
  // Modo código sem pasta não tem em que trabalhar: o envio fica bloqueado até
  // escolher uma (o texto continua editável).
  const precisaDePasta = isCode && folders.length === 0

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
      // Sem pasta o modo código não roda: o botão já está desabilitado, mas as
      // sugestões chamam o envio direto.
      if (codeMode && foldersRef.current.length === 0) return
      const dirConfig = codeMode
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

        // Pasta escolhida no "+" da sidebar tem precedência: é uma decisão
        // explícita, não vale sobrescrever com o mapeamento automático.
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

  // Closure inline aqui virava prop nova a cada render e derrubava o memo do
  // MessageList — que existe justamente para a lista não reconciliar à toa.
  const handleLoadOlder = useCallback(() => {
    if (sessionId) void loadOlderMessages(sessionId)
  }, [sessionId, loadOlderMessages])

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
        <View className="pb-2">
          <PlanReviewCard sessionId={sessionId!} review={planReview} />
        </View>
      )
    }
    if (planReview && planReview.status === 'implementing') {
      return (
        <View className="pb-2">
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

  // O inset de baixo NÃO entra no SafeScreen: com o teclado aberto ele sobrava
  // entre o input e o teclado (o KAV já empurra a coluna inteira). Quem aplica
  // o respiro de baixo é o PromptInput, que sabe se o teclado está aberto.
  return (
    <SafeScreen edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* KAV do react-native-keyboard-controller: mesma API do RN, mas a
          animação roda na thread nativa em sincronia com o teclado — sem o
          lag de abrir/fechar do KAV clássico (que só reage no keyboardDidShow/
          Hide). A coluna inteira acompanha: header fixo, conversa encolhe,
          input rente ao teclado.

          A lib calcula o padding como `bottom do frame - (altura da tela -
          teclado - offset)`, e o frame já nasce deslocado pelo paddingTop do
          SafeScreen — passar o inset de cima como offset somava a altura da
          notch ao espaço do teclado. O offset NEGATIVO aqui desconta o respiro
          que o input aplica fixo embaixo: assim o padding animado vale
          `teclado - respiro`, o total bate nos dois extremos e só existe UMA
          animação (duas saíam de fase e faziam o input passar do ponto). */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={-respiroDoInput}
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
                onLoadOlder={handleLoadOlder}
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
            {precisaDePasta && (
              <Text style={{ fontSize: 11, marginTop: 6, color: tokens.mutedForeground }}>
                {t('chatScreen.folderRequired')}
              </Text>
            )}
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
          sendDisabled={precisaDePasta}
          onCreateSession={onCreateSession}
          onNavigateToSession={onNavigateToSession}
        />
      </KeyboardAvoidingView>
    </SafeScreen>
  )
}
