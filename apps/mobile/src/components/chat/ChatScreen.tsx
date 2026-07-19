import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import { View, Text, Animated } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import type { SendMessageOptions, FilePart } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useChatStore } from '~/stores/chat-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { MessageList } from '~/components/chat/MessageList'
import { ChatInput } from '~/components/chat/ChatInput'
import { AskCard } from '~/components/chat/AskCard'
import { Suggestions } from '~/components/chat/Suggestion'
import { ChatHeader } from '~/components/chat/ChatHeader'
import { FolderSelector } from '~/components/chat/FolderSelector'
import { Persona } from '~/components/ai/Persona'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const DEFAULT_SUGGESTIONS = [
  'What can you help me with?',
  'Explain a concept simply',
  'Help me brainstorm ideas',
  'Review my code',
]

interface ChatScreenProps {
  /** ID da sessão existente. Ausente = rascunho de conversa nova. */
  sessionId?: string
}

// Referência estável para o seletor do zustand (evita loop de getSnapshot)
const NO_MESSAGES: never[] = []

export function ChatScreen({ sessionId }: ChatScreenProps) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const mode = useWorkspaceStore((s) => s.mode)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const sessions = useSessionStore((s) => s.sessions)
  // Seletores estreitos: assinar o mapa inteiro re-renderizava a tela toda a
  // cada delta de QUALQUER sessão (e o mapa muda de identidade em todo set).
  const activeMessages = useSessionStore((s) =>
    sessionId ? s.messages[sessionId] ?? NO_MESSAGES : NO_MESSAGES,
  )
  const activeStatus = useSessionStore((s) => (sessionId ? s.status[sessionId] : undefined))
  const selectSession = useSessionStore((s) => s.selectSession)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const createSession = useSessionStore((s) => s.createSession)
  const abortChat = useSessionStore((s) => s.abortChat)
  const renameSession = useSessionStore((s) => s.renameSession)
  const setPinned = useSessionStore((s) => s.setPinned)
  const setArchived = useSessionStore((s) => s.setArchived)
  const forkSession = useSessionStore((s) => s.forkSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const replyToAsk = useChatStore((s) => s.replyToAsk)

  const session = useMemo(() => sessions.find((s) => s.id === sessionId), [sessions, sessionId])
  const isStreaming = activeStatus === 'streaming' || activeStatus === 'submitted'
  const activeAsks = sessionId ? pendingAsks[sessionId] ?? [] : []
  const isEmpty = activeMessages.length === 0

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
  }, [sessionId])

  // Cria a sessão no primeiro envio quando ainda é um rascunho (sem id).
  const [creating, setCreating] = useState(false)

  // Pastas do modo código: rascunho começa vazio; sessão existente herda as
  // pastas dela (e mudanças são persistidas no próximo envio).
  const [folders, setFolders] = useState<string[]>([])
  useEffect(() => {
    if (session?.directory) {
      setFolders([session.directory, ...(session.extraDirectories ?? [])])
    }
  }, [session?.directory, session?.extraDirectories])

  const isCode = (session?.mode ?? mode) === 'code'

  const handleSend = useCallback(
    async (text: string, options?: SendMessageOptions, files?: FilePart[]) => {
      const dirConfig = isCode && folders.length > 0
        ? { directory: folders[0], extraDirectories: folders.slice(1) }
        : {}
      if (sessionId) {
        sendMessage(text, { options, files, sessionId, ...dirConfig })
        return
      }
      if (creating) return
      setCreating(true)
      try {
        const created = await createSession(mode)
        if (!created) return
        sendMessage(text, { options, files, sessionId: created.id, ...dirConfig })
        router.replace({ pathname: '/(main)/chat/[id]', params: { id: created.id } })
      } finally {
        setCreating(false)
      }
    },
    [sessionId, sendMessage, createSession, mode, router, creating, isCode, folders],
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

  const handleDelete = useCallback(async () => {
    if (!sessionId) return
    await deleteSession(sessionId)
    router.replace('/(main)')
  }, [sessionId, deleteSession, router])

  const personaState = isEmpty ? 'idle' : isStreaming ? 'thinking' : 'idle'

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} edges={['top', 'bottom']}>
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
        />

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
            <Persona state="idle" size={112} />
            <View style={{ marginTop: 16, alignItems: 'center', gap: 4 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', color: tokens.foreground }}>Nova conversa</Text>
              <Text style={{ fontSize: 14, color: tokens.mutedForeground }}>Comece a conversar com o assistente.</Text>
            </View>
          </Animated.View>

          {/* Mensagens — aparece assim que a conversa começa */}
          <Animated.View pointerEvents={isEmpty ? 'none' : 'auto'} style={{ flex: 1, opacity: chatProgress }}>
            {!isEmpty && <MessageList messages={activeMessages} isStreaming={isStreaming} />}
          </Animated.View>
        </View>

        {/* Sugestões — ancoradas acima do input, só na conversa vazia */}
        {isEmpty && (
          <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
            <Suggestions suggestions={DEFAULT_SUGGESTIONS} onSelect={handleSuggestion} />
          </View>
        )}

        {/* Modo código: seleção da pasta principal + adicionais (como no desktop) */}
        {isCode && (
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <FolderSelector folders={folders} onFoldersChange={setFolders} />
          </View>
        )}

        {/* Ask cards — acima do input */}
        {activeAsks.map((ask) => (
          <AskCard key={ask.requestId} ask={ask} onReply={(value) => replyToAsk(ask.requestId, value)} />
        ))}

        <ChatInput onSend={handleSend} onAbort={handleAbort} isStreaming={isStreaming} sessionId={sessionId} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
