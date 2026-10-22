import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AudioPlayerCard } from "@/src/components/messages/audio-part"
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom"
import { useTranslation } from "react-i18next"
import { ChevronRight, History, PaperclipIcon, Plug, Sparkles } from "lucide-react"
import { UserMessageNav } from "@/src/components/user-message-nav"
import { useWorkspace } from "@/lib/workspace-context"
import type { ChatMessage, FilePart, OrchestrationPlan, PlanReview, SendMessageOptions } from "@shared/chat"
import { AskCard } from "@/src/components/ask-card"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { VisionHintCard } from "@/src/components/vision-hint-card"
import { ProviderHintCard } from "@/src/components/provider-hint-card"
import { Persona, retryPersona, type PersonaState } from "@/src/components/ai/persona"
import { useVoiceActivity, voiceActivityState } from "@/src/stores/voice-activity"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import { ErrorBoundary } from "@/src/components/error-boundary"
import { showsPersonaInChat, showsPersonaOnWelcome } from "@shared/appearance"
import { usePanelStore } from "@/src/stores/panel-store"
import { chatApi, docsApi, mediaApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import { mediaKind, type MediaKind } from "@shared/media"
import { CapabilitiesDialog } from "@/src/components/capabilities-dialog"
import { CapabilityIcon } from "@/src/components/capability-icon"
import { buildStartSuggestions, type StartSuggestion } from "@/src/lib/start-suggestions"
import { useDraftInput } from "@/src/stores/draft-input"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { Message, MessageAttachment, MessageAttachments, MessageContent } from "@/src/components/ai/message"
import { Suggestion } from "@/src/components/ai/suggestion"
import { ChatAssistantMessage } from "@/src/components/messages/chat-message"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { SummaryCard } from "@/src/components/messages/summary-card"
import { OrchestrationPlanCard } from "@/src/components/orchestration-plan-card"
import { TaskProgress } from "@/src/components/task-progress"
import { PlanReviewCard } from "@/src/components/plan-review-card"
import { InitProjectCard } from "@/src/components/init-project-card"
import { RevertBar } from "@/src/components/revert-bar"
import {
  AssistantMessageActions,
  CopyAction,
  MessageTimestamp,
  ReplyAction,
  RevertAction,
  UserMessageText,
} from "@/src/components/messages/shared"
import { MessageReplySelection } from "@/src/components/message-reply-selection"
import { DateSeparator, isNewDay } from "@/src/components/messages/date-separator"
import { ChatMessageSearchBar } from "@/src/components/chat-message-search-bar"
import { useChatSearchStore } from "@/src/stores/chat-search-store"
import { Actions } from "@/src/components/ai/actions"
import { messageBody, messageText, visibleMessageText } from "@/src/lib/message-utils"
import { PAGE_TURNS, defaultWindowStart, turnStart, windowStartFor } from "@/src/lib/message-window"
import { registerMessageRevealer, revealMessage } from "@/src/lib/message-jump"
import { playEntranceSound, prepareEntranceSound } from "@/src/lib/entrance-sound"
import { useActiveSession, useSessionStatus, useSessionStore, type SendConfig } from "@/src/stores/session-store"
import { pastasAposTroca, useWorktreeStore } from "@/src/stores/worktree-store"
import { useProviderStore, useNoProviderConnected, useProvidersLoading } from "@/src/stores/provider-store"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useSimpleMode } from "@/src/stores/simple-prefs"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { detectUserName } from "@shared/user-name"
import { VOICE_DEFAULTS } from "@shared/voice"

// Referências estáveis para seletores do zustand (evita loop de getSnapshot)
const NO_MESSAGES: ChatMessage[] = []
const NO_ASKS: never[] = []

/** Extensões que viram documento da conversa — é o que decide se o chip abre. */
const DOCUMENT_FILE = /\.(pdf|docx|xlsx|xls|ods|csv)$/i

/**
 * Abertura da tela de boas-vindas: três falas antes do convite.
 *
 * INTRO_START_MS é o atraso que a primeira fala herda do antigo "Pronto para
 * começar?" — o tempo que a persona leva para acordar. A partir daí tudo anda
 * no mesmo passo (INTRO_STEP_MS): cada fala começa um passo depois da
 * anterior, o convite final entra um passo depois da última, e o subtítulo e o
 * botão entram um passo depois do convite. Cada fala dura INTRO_LINE_MS, um
 * pouco mais que o passo — é o que faz a anterior ainda estar saindo quando a
 * seguinte entra.
 *
 * INTRO_TOTAL_MS é quando o convite assume o lugar das falas; é o atraso que o
 * efeito de abertura usa.
 */
const INTRO_START_MS = 1200
const INTRO_STEP_MS = 1400
const INTRO_LINE_MS = 1500
/** Quantas falas vêm antes do convite. */
const INTRO_STEPS = 3
const INTRO_TOTAL_MS = INTRO_START_MS + INTRO_STEP_MS * INTRO_STEPS

/**
 * Chip do anexo não-imagem. Clicar abre o arquivo no painel.
 *
 * O `documentId` vem no chip desde que ele passou a ser gravado; nos anexos
 * anteriores a isso ele não existe, e aí o documento é reencontrado pelo NOME
 * entre as fontes da conversa. Sem esse resgate, toda mensagem antiga ficaria
 * com um anexo permanentemente inerte.
 *
 * O NOME também é o plano B de um id que não resolve mais: arrastar o arquivo
 * para as fontes da pasta troca doc1 por src1, e o chip guarda o id como ele
 * era no dia do envio. O backend segue o rastro sozinho, mas aqui o nome é
 * prova melhor — ele identifica o arquivo mesmo quando a conversa promoveu
 * dois documentos e o rastro se perdeu.
 */
function DocumentChip({ file, sessionId }: { file: FilePart; sessionId?: string }) {
  const { t } = useTranslation()
  const openable = Boolean(sessionId) && (!!file.documentId || DOCUMENT_FILE.test(file.filename ?? ""))

  const open = async () => {
    if (!sessionId) return
    let docId = file.documentId
    const { shared, own } = await docsApi.list(sessionId)
    const docs = [...own, ...shared]
    if (!docId || !docs.some((d) => d.id === docId)) {
      docId = docs.find((d) => d.filename === file.filename)?.id ?? docId
    }
    if (!docId) return
    usePanelStore.getState().openSourceTab(sessionId, {
      docId,
      page: 1,
      title: file.filename ?? docId,
    })
  }

  return (
    <button
      type="button"
      disabled={!openable}
      onClick={() => void open()}
      title={openable ? t("sources.openInPanel") : undefined}
      className="flex h-7 select-none items-center gap-1.5 rounded-md border border-border px-1.5 text-sm enabled:cursor-pointer enabled:hover:bg-accent disabled:cursor-default"
    >
      <PaperclipIcon className="size-3 text-muted-foreground" />
      <span className="truncate">{file.filename ?? t("attachments.unnamedFile")}</span>
    </button>
  )
}

// Memoizado por referência da mensagem + flags: no flush de deltas só a
// mensagem streamando muda de referência — as demais não re-renderizam.
// `messages`/`sendMessage` ficam fora da comparação de propósito: o retry usa
// `slice(0, index)`, imune a mensagens novas anexadas ao final da lista.
const MessageItem = memo(
  function MessageItem({ msg, isLast, waiting, finished, isBusy, busyLabel, mode, sessionId, sendMessage, messages, index }: {
    msg: ChatMessage
    isLast: boolean
    waiting: boolean
    finished: boolean
    isBusy: boolean
    busyLabel?: string
    mode: "chat" | "code"
    sessionId?: string
    sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
    messages: ChatMessage[]
    index: number
  }) {
  const { t } = useTranslation()

  const handleRetry = useCallback(() => {
    const prevUser = [...messages].slice(0, index).reverse().find((m) => m.role === "user")
    if (prevUser && sessionId) {
      void sendMessage(mode, messageText(prevUser), { options: {}, sessionId })
    }
  }, [messages, index, mode, sessionId, sendMessage])

  if (msg.role === "user") {
    const files = msg.parts.filter((p): p is FilePart => p.type === "file")
    return (
      <Message from="user" data-user-msg-id={msg.id} data-msg-id={msg.id} data-msg-role="user">
        <div className="group/user-msg flex flex-col">
          {files.length > 0 && (
            <MessageAttachments className="mb-1">
              {files.map((file) =>
                file.mime.startsWith("image/") ? (
                  <MessageAttachment
                    key={file.id}
                    // `mediaUrl` vai junto: a `url` do chip é só o thumbnail
                    // da bolha, e é ele que o visualizador amplia e que os
                    // botões de copiar e salvar entregam. Omiti-lo aqui fazia
                    // o "salvar" devolver um webp de 320px no lugar da foto.
                    data={{
                      type: "file",
                      mediaType: file.mime,
                      filename: file.filename,
                      url: file.url,
                      mediaUrl: file.mediaUrl,
                    }}
                  />
                ) : file.mime.startsWith("video/") && file.url ? (
                  // Vídeo anexado: o main guardou o arquivo e deixou um quadro como
                  // miniatura no chip. A bolha mostra esse quadro (o vídeo em si só
                  // o agente alcança, por referência).
                  <MessageAttachment
                    key={file.id}
                    data={{ type: "file", mediaType: "image/webp", filename: file.filename, url: file.url }}
                  />
                ) : file.mime.startsWith("audio/") && file.mediaUrl ? (
                  // Áudio anexado: toca na própria bolha. O que ele diz (se o
                  // agente transcrever) fica na nota do anexo, não aqui.
                  <AudioPlayerCard
                    key={file.id}
                    className="w-72 max-w-full"
                    src={file.mediaUrl}
                    title={file.filename || t("audio.attachment")}
                  />
                ) : (
                  // Anexo que virou documento abre no painel; os demais (texto
                  // solto, elemento do browser) não têm o que abrir — o
                  // conteúdo deles está na própria mensagem.
                  <DocumentChip key={file.id} file={file} sessionId={sessionId} />
                ),
              )}
            </MessageAttachments>
          )}
          <MessageContent>
            <UserMessageText text={visibleMessageText(msg)} />
          </MessageContent>
          <Actions className="-mb-1 items-center justify-end opacity-0 transition-opacity group-hover/user-msg:opacity-100">
            <MessageTimestamp timestamp={msg.createdAt} />
            <CopyAction text={visibleMessageText(msg)} />
            <ReplyAction message={msg} sessionId={sessionId} />
            {/* Falar lê a RESPOSTA do assistente — a mensagem do usuário não
                ganha o botão (nada dela é lido em voz alta). */}
            <RevertAction messageId={msg.id} sessionId={sessionId} />
          </Actions>
        </div>
      </Message>
    )
  }

  return (
    <Message from="assistant" data-msg-id={msg.id} data-msg-role="assistant">
      <MessageContent data-msg-surface>
        {mode === "chat" ? (
          <ChatAssistantMessage
            message={msg}
            sessionId={sessionId}
            isLast={isLast}
            isBusy={isBusy}
            busyLabel={busyLabel}
            onRetry={handleRetry}
          />
        ) : (
          // `diffInFooter`: o "+N -N" sai no rodapé da mensagem, junto das
          // outras ações — e não no cabeçalho do acordeon, que recolhe.
          <CodeAssistantMessage
            message={msg}
            sessionId={sessionId}
            isLast={isLast}
            isBusy={isBusy}
            busyLabel={busyLabel}
            onRetry={handleRetry}
            diffInFooter
          />
        )}
      </MessageContent>
      {finished && !waiting && <AssistantMessageActions message={msg} sessionId={sessionId} />}
    </Message>
  )
  },
  (prev, next) =>
    prev.msg === next.msg &&
    prev.isLast === next.isLast &&
    prev.waiting === next.waiting &&
    prev.finished === next.finished &&
    prev.isBusy === next.isBusy &&
    prev.busyLabel === next.busyLabel &&
    prev.mode === next.mode &&
    prev.sessionId === next.sessionId &&
    prev.index === next.index,
)

function BrokenMessage({ error }: { error: Error }) {
  const { t } = useTranslation()
  return (
    <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
      <p className="font-medium text-destructive">{t("chat.brokenMessage")}</p>
      <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{error.message}</p>
    </div>
  )
}

/**
 * Topo da janela de mensagens: monta os turnos anteriores quando a pessoa
 * rola até perto dele. Só reage depois que ela saiu do fim da conversa — ao
 * abrir o chat o topo está na tela antes de a rolagem inicial descer, e
 * carregar ali montaria o histórico inteiro, que é o que a janela evita.
 * Também carrega quando a janela nem enche a tela (não há o que rolar).
 */
function EarlierMessages({ hiddenCount, onLoad, paused }: {
  hiddenCount: number
  onLoad: () => void
  /** Durante um pulo para mensagem: carregar aqui mexeria no scroll no meio
   *  da rolagem até o alvo. */
  paused: () => boolean
}) {
  const { t } = useTranslation()
  const { scrollRef, isAtBottom } = useStickToBottomContext()
  const ref = useRef<HTMLButtonElement>(null)
  const isAtBottomRef = useRef(isAtBottom)
  isAtBottomRef.current = isAtBottom
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const scroller = scrollRef.current
    const el = ref.current
    if (!scroller || !el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || pausedRef.current()) return
        const fills = scroller.scrollHeight > scroller.clientHeight + 1
        if (!fills || !isAtBottomRef.current) onLoadRef.current()
      },
      { root: scroller, rootMargin: "600px 0px 0px 0px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef])

  return (
    <button
      ref={ref}
      type="button"
      onClick={onLoad}
      className="mx-auto rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {t("chat.earlierMessages", { count: hiddenCount })}
    </button>
  )
}

function ChatMessages({ messages, historyPending, isBusy, busyLabel, mode, sessionId, sendMessage, planIds, planReview, plan }: {
  messages: ChatMessage[]
  /** O histórico da sessão ainda não chegou do disco. */
  historyPending: boolean
  isBusy: boolean
  busyLabel?: string
  mode: "chat" | "code"
  sessionId?: string
  sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
  planIds: Set<string>
  planReview: PlanReview | undefined
  plan?: OrchestrationPlan | undefined
}) {
  const { t } = useTranslation()
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant" && !m.summary)?.id

  const userMsgItems = useMemo(
    () =>
      messages
        .filter((m) => m.role === "user")
        .map((m) => ({ id: m.id, text: messageBody(m), time: m.createdAt })),
    [messages],
  )

  // ── Janela: só os últimos turnos ficam montados (ver message-window.ts) ──
  // Guardada pelo ID da primeira mensagem, não pelo índice: mensagens novas
  // chegam no fim e não podem deslocar a janela. Fica fixa depois de definida
  // (o chat que cresce não desmonta o que está acima); trocar de sessão ou a
  // mensagem sumir (revert, compactação) volta ao padrão.
  const [windowState, setWindowState] = useState<{ sessionId?: string; startId: string | null }>({
    sessionId,
    startId: null,
  })
  // Atualizações de estado durante o render (estado derivado): o React
  // descarta este render e refaz com o valor novo, sem passar pelo DOM.
  const sameSession = windowState.sessionId === sessionId
  if (!sameSession) setWindowState({ sessionId, startId: null })
  let startIndex = 0
  if (messages.length > 0) {
    const saved = sameSession ? windowState.startId : null
    const savedIndex = saved ? messages.findIndex((m) => m.id === saved) : -1
    startIndex = savedIndex >= 0 ? savedIndex : defaultWindowStart(messages)
    if (savedIndex < 0) setWindowState({ sessionId, startId: messages[startIndex].id })
  }
  const visibleMessages = startIndex > 0 ? messages.slice(startIndex) : messages

  const stickRef = useRef<StickToBottomContext>(null)
  /** Medidas do scroll antes de montar turnos acima — para manter na tela o
   *  que a pessoa estava lendo quando o conteúdo cresce por cima. */
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const startIndexRef = useRef(startIndex)
  startIndexRef.current = startIndex
  /** Até quando o carregamento automático do topo fica parado (pulo em curso). */
  const jumpUntilRef = useRef(0)
  const autoLoadPaused = useCallback(() => Date.now() < jumpUntilRef.current, [])

  const loadEarlier = useCallback(() => {
    const current = startIndexRef.current
    if (current <= 0) return
    const scroller = stickRef.current?.scrollRef.current
    if (scroller) anchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop }
    const list = messagesRef.current
    setWindowState({ sessionId, startId: list[turnStart(list, current, PAGE_TURNS)].id })
  }, [sessionId])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const scroller = stickRef.current?.scrollRef.current
    if (!anchor || !scroller) return
    anchorRef.current = null
    // O Chromium pode já ter compensado sozinho (scroll anchoring); só mexe
    // se a posição não for a esperada.
    const expected = anchor.top + (scroller.scrollHeight - anchor.height)
    if (Math.abs(scroller.scrollTop - expected) > 1) scroller.scrollTop = expected
  }, [startIndex])

  // Abre no fim ANTES do primeiro quadro: o StickToBottom só desce num
  // requestAnimationFrame, e até lá o chat aparecia no topo por um instante.
  // Roda quando a conversa monta (troca de sessão ou histórico que chegou).
  useLayoutEffect(() => {
    if (historyPending) return
    const scroller = stickRef.current?.scrollRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [sessionId, historyPending])

  // A área do chat também muda de altura sem o conteúdo mudar: a persona do
  // header entra com o véu (o chat encolhe ~64px), o campo de texto cresce,
  // um card aparece acima do input. O StickToBottom só observa o conteúdo,
  // então nesses casos o fim da conversa ficava escondido embaixo. Colado no
  // fim antes da mudança, continua colado depois.
  useEffect(() => {
    if (historyPending) return
    const scroller = stickRef.current?.scrollRef.current
    if (!scroller) return
    let lastHeight = scroller.clientHeight
    const observer = new ResizeObserver(() => {
      const height = scroller.clientHeight
      if (height === lastHeight) return
      const gapBefore = scroller.scrollHeight - scroller.scrollTop - lastHeight
      lastHeight = height
      if (stickRef.current?.isAtBottom || gapBefore <= 2) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [sessionId, historyPending])

  // Pular para uma mensagem fora da janela (busca, navegador, galeria):
  // estende a janela até o turno dela. O stopScroll solta a trava do fim —
  // senão o conteúdo novo acima faria a conversa ser puxada de volta para
  // baixo enquanto a busca tenta rolar até a mensagem.
  useEffect(() => {
    return registerMessageRevealer((messageId) => {
      const list = messagesRef.current
      const index = list.findIndex((m) => m.id === messageId)
      if (index < 0) return false
      if (index < startIndexRef.current) {
        stickRef.current?.stopScroll()
        jumpUntilRef.current = Date.now() + 1500
        // Turnos extras acima do alvo: o topo da janela fica longe dele, e
        // rolar um pouco para cima depois do pulo não esbarra no limite.
        const start = turnStart(list, windowStartFor(list, index), PAGE_TURNS)
        setWindowState({ sessionId, startId: list[start].id })
      }
      return true
    })
  }, [sessionId])

  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const ratioMapRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const ids = userMsgItems.map((i) => i.id)
    const key = ids.join(",")
    if (!key) return

    const ratioMap = ratioMapRef.current
    ratioMap.clear()

    if (observerRef.current) observerRef.current.disconnect()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-user-msg-id")
          if (id) ratioMap.set(id, entry.intersectionRatio)
        }
        let maxId: string | null = null
        let maxRatio = 0
        for (const [id, ratio] of ratioMap) {
          if (ratio > maxRatio) {
            maxRatio = ratio
            maxId = id
          }
        }
        setActiveUserMsgId(maxId)
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
    )

    observerRef.current = observer

    const els = document.querySelectorAll<HTMLElement>("[data-user-msg-id]")
    for (const el of els) observer.observe(el)

    return () => observer.disconnect()
    // Re-observa quando a janela cresce: as perguntas recém-montadas no topo
    // também contam para o destaque do navegador.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMsgItems.map((i) => i.id).join(","), startIndex])

  const handleNavSelect = useCallback(async (id: string) => {
    const el = await revealMessage(id)
    if (!el) return
    // Rola o container de scroll real (div interna do StickToBottom), que fica
    // sob um ancestral com overflow-y-hidden — scrollIntoView nem sempre rola
    // o container certo nessa estrutura.
    let scroller = el.parentElement
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (overflowY === "auto" || overflowY === "scroll") break
      scroller = scroller.parentElement
    }
    if (!scroller) return
    const containerRect = scroller.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const target =
      scroller.scrollTop +
      (elRect.top - containerRect.top) -
      (scroller.clientHeight - elRect.height) / 2
    const max = scroller.scrollHeight - scroller.clientHeight
    scroller.scrollTo({ top: Math.max(0, Math.min(target, max)), behavior: "smooth" })
  }, [])

  // Sem o histórico, a conversa não monta. Montada vazia, a primeira medição
  // do StickToBottom (a que rola sem animar) era gasta na lista vazia, e o
  // histórico chegando depois virava "conteúdo cresceu": a mola suave descia
  // o chat inteiro do topo até o fim, à vista.
  if (historyPending) return <div className="relative flex-1" />

  return (
    // initial="instant": o chat abre já no fim, sem rolar por tudo até lá.
    <Conversation key={sessionId ?? "no-session"} contextRef={stickRef} initial="instant" className="relative flex-1 -mt-10">
      <ConversationContent className="mx-auto w-full max-w-3xl">
        {startIndex > 0 && (
          // key pela janela: cada carga remonta o observador, que reavalia na
          // hora se o topo continua perto (rolagem rápida pede mais de uma)
          <EarlierMessages key={messages[startIndex].id} hiddenCount={startIndex} onLoad={loadEarlier} paused={autoLoadPaused} />
        )}
        {visibleMessages.map((msg, visibleIndex) => {
          // Índice no histórico inteiro: separador de data e retry olham a
          // mensagem anterior de verdade, montada ou não.
          const index = startIndex + visibleIndex
          const showSeparator = isNewDay(messages[index - 1]?.createdAt, msg.createdAt)

          if (msg.summary) {
            return (
              <div key={msg.id}>
                {showSeparator && <DateSeparator timestamp={msg.createdAt} />}
                <SummaryCard message={msg} />
              </div>
            )
          }

          const isLast = msg.id === lastAssistantId
          const finished = msg.role !== "assistant" || !(isLast && isBusy)
          const waiting = msg.role === "assistant" && isLast && isBusy && msg.parts.length === 0

          return (
            <div key={msg.id}>
              {showSeparator && <DateSeparator timestamp={msg.createdAt} />}
              {/* Uma mensagem que o renderer não sabe desenhar — em geral
                  dado gravado por uma versão anterior — vira um aviso no
                  lugar dela. Antes ela apagava a conversa inteira. */}
              <ErrorBoundary
                label={`mensagem ${msg.id}`}
                resetKeys={[msg]}
                fallback={(error) => <BrokenMessage error={error} />}
              >
                <MessageItem
                  msg={msg}
                  isLast={isLast}
                  waiting={waiting}
                  finished={finished}
                  isBusy={isBusy}
                  busyLabel={busyLabel}
                  mode={mode}
                  sessionId={sessionId}
                  sendMessage={sendMessage}
                  messages={messages}
                  index={index}
                />
              </ErrorBoundary>
            </div>
          )
        })}
        {planReview && planReview.status === "proposed" && sessionId && (
          // max-w-2xl para alinhar com o input: a conversa é max-w-3xl, e o
          // card ficava mais largo que a caixa de mensagem logo abaixo dele.
          <div className="mx-auto w-full max-w-2xl px-1">
            <PlanReviewCard sessionId={sessionId} review={planReview} />
          </div>
        )}
        {planReview && planReview.status === "implementing" && sessionId && !plan && (
          <div className="px-1">
            <TaskProgress
              tasks={[{ id: "plan", title: t("chat.implementPlan"), status: isBusy ? "streaming" : "idle" }]}
              title={t("chat.planTitle")}
              onDismiss={() => useSessionStore.getState().dismissPlanReview(sessionId)}
            />
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
      <UserMessageNav items={userMsgItems} activeId={activeUserMsgId} onSelect={handleNavSelect} planIds={planIds} />
      {/* Selecionar um trecho e responder só ele — dentro do Conversation
          porque é o elemento de rolagem dele que delimita a área válida. */}
      <MessageReplySelection sessionId={sessionId} />
    </Conversation>
  )
}

// Abertura do app: a persona central nasce dormindo e acorda ~650ms após a
// montagem. O som de entrada é tocado pelo renderer (WebAudio) neste mesmo
// instante — áudio e persona começam juntos (ver src/lib/entrance-sound.ts).
// Os flags são por módulo/processo — trocas de tela seguintes usam a transição
// normal.
let entranceWakeDone = false
const isInitialLaunch = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("entrance")

/** O ponto dourado do link "O que o Orbit faz?" some depois da primeira vez. */
const CAPABILITIES_SEEN_KEY = "orbit-capabilities-seen"

/** `embedded`: o chat está numa aba do painel lateral. Lá o espaço vertical é
 *  curto e a aba já diz qual chat é, então persona do topo e breadcrumb saem. */
export function ChatView({ sessionId, embedded = false }: { sessionId?: string; embedded?: boolean } = {}) {
  const { mode, setMode, folders, setFolders } = useWorkspace()
  const activeSession = useActiveSession(mode)
  const explicitSession = useSessionStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined,
  )
  const session = sessionId ? explicitSession : activeSession
  const viewMode = session?.mode ?? mode
  const messages = useSessionStore((s) =>
    session ? s.messages[session.id] ?? NO_MESSAGES : NO_MESSAGES,
  )
  const status = useSessionStatus(session?.id)
  const fallback = useSessionStore((s) => (session ? s.fallback[session.id] : undefined))
  const plan = useSessionStore((s) => (session ? s.orchestration[session.id] : undefined))
  const planReview = useSessionStore((s) => (session ? s.planReviews[session.id] : undefined))
  const pendingAsks = useSessionStore((s) => (session ? s.pendingAsks[session.id] ?? NO_ASKS : NO_ASKS))
  // IDs de mensagens de usuário que geraram planos — computado do review + mensagens
  const planMsgIds = useMemo(() => {
    const ids = new Set<string>()
    if (!planReview || !session) return ids
    if (planReview.status !== "proposed" && planReview.status !== "implementing") return ids
    const idx = messages.findIndex((m) => m.id === planReview.messageId)
    if (idx > 0 && messages[idx - 1].role === "user") ids.add(messages[idx - 1].id)
    return ids
  }, [planReview, messages, session])
  const parentSession = useSessionStore((s) =>
    session?.parentId ? s.sessions.find((x) => x.id === session.parentId) : undefined,
  )
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const selectSession = useSessionStore((s) => s.selectSession)
  const initializeProviders = useProviderStore((s) => s.initialize)
  // Default de brain/simple vem das preferências de modos ativos do modo atual
  const modeDefaults = useModelModePrefs((s) => (viewMode === "code" ? s.codeActiveModes : s.chatActiveModes))
  const simpleMode = useSimpleMode(session?.id, modeDefaults.simple)
  const chatSearchOpen = useChatSearchStore((s) => s.open)

  useEffect(() => {
    void initializeProviders()
  }, [initializeProviders])

  // Carrega o histórico tanto para views explícitas (workers/painel) quanto
  // para a sessão principal. Após um reload do renderer, o status pode voltar
  // como streaming antes de a lista de mensagens ter sido hidratada; sem este
  // efeito a UI ficava vazia enquanto o engine continuava rodando.
  useEffect(() => {
    if (session?.id) void useSessionStore.getState().ensureMessages(session.id)
  }, [session?.id])

  // Fecha a busca ao trocar de sessão para não deixar resultados obsoletos visíveis
  useEffect(() => {
    useChatSearchStore.getState().close()
  }, [session?.id])

  // Sincroniza pasta da sessão (ex.: vinda do mobile) com o workspace. Além
  // da troca de chat, segue a troca de pasta da MESMA sessão feita fora da
  // tela — o agente mudando o chat de worktree (worktree_switch/create).
  // Sem isso, o próximo envio gravaria de volta a pasta antiga.
  const prevSessionId = useRef(session?.id)
  const prevDirectory = useRef(session?.directory)
  useEffect(() => {
    if (viewMode !== "code" || !session?.directory) return
    const trocouChat = session.id !== prevSessionId.current
    const trocouPasta = !trocouChat && session.directory !== prevDirectory.current
    prevSessionId.current = session.id
    prevDirectory.current = session.directory
    if (trocouChat) {
      setFolders([session.directory, ...(session.extraDirectories ?? [])])
    } else if (trocouPasta && useSessionStore.getState().activeIds.code === session.id) {
      // Mesma sessão, pasta trocada pelo agente: as extras do workspace ficam
      // (inclusive as associadas depois do último envio) e vão para a sessão.
      // Só no chat ativo — o workspace é dele; um chat no painel lateral não
      // mexe nas pastas da tela.
      const proximas = pastasAposTroca(session.directory, folders)
      setFolders(proximas)
      useSessionStore.getState().setSessionDirectories(session.id, session.directory, proximas.slice(1))
    }
    if (trocouChat || trocouPasta) {
      // Pasta que chegou de fora pode ser um worktree: registra o principal
      // dela para a sidebar agrupar os próximos chats no projeto certo.
      void useWorktreeStore.getState().resolverPrincipal(session.directory)
    }
    // folders entra só para a troca ler as extras atuais; mudar só as pastas
    // não dispara nada (nem chat nem pasta principal da sessão mudaram).
  }, [session?.id, session?.directory, session?.extraDirectories, viewMode, setFolders, folders])

  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  // Sessão cujo histórico ainda não chegou do disco conta como conversa: sem
  // isso, trocar de chat passava pela tela de início (lista vazia por um
  // instante) e rodava as animações de saída e entrada antes de mostrar o
  // chat escolhido.
  const historyPending = useSessionStore((s) => (session ? s.messages[session.id] === undefined : false))
  const hasChat = messages.length > 0 || historyPending
  const personaVisibility = useAppearanceStore((s) => s.personaVisibility)
  /** A flutuante do topo passa por cima da conversa; a da saudação não
   *  disputa espaço com nada. São escolhas separadas — ver PersonaVisibility. */
  const personaInChat = showsPersonaInChat(personaVisibility)
  const personaOnWelcome = showsPersonaOnWelcome(personaVisibility)
  // Pasta alvo do card de init: a da sessão ou a selecionada no FolderSelector
  const initDirectory = session?.directory ?? (viewMode === "code" ? folders[0] : undefined)

  const prevHasChat = useRef(hasChat)
  const isBusyRef = useRef(isBusy)
  isBusyRef.current = isBusy

  // Voz em curso (fala do TTS ou ditado) — publicada pelos próprios botões em
  // `stores/voice-activity`, porque a persona não tem ligação com eles.
  const voiceActivity = useVoiceActivity()
  const [displayCenterState, setDisplayCenterState] = useState<PersonaState>("asleep")
  const [displayTopState, setDisplayTopState] = useState<PersonaState>(
    hasChat ? (isBusy ? "thinking" : "idle") : "asleep",
  )
  const [topVisible, setTopVisible] = useState(hasChat)
  /** Opacidade da persona do topo, separada da montagem: na saída ela some com
   *  fade e só desmonta depois, quando a animação de dormir terminou. */
  const [topOpaque, setTopOpaque] = useState(hasChat)
  const [centerVisible, setCenterVisible] = useState(!hasChat)
  const [centerPersonaVisible, setCenterPersonaVisible] = useState(!hasChat)
  const [chatVisible, setChatVisible] = useState(hasChat)
  /**
   * O convite da tela inicial entra DEPOIS da persona, não junto: lado a lado
   * de tempo os dois competem e a tela parece que piscou. Em sequência, a
   * pessoa vê o Orbit primeiro e o texto em seguida.
   */
  const [introVisible, setIntroVisible] = useState(false)
  // Card de provedor ausente: aparece quando o usuário tenta enviar sem
  // provider configurado (input ou sugestão) e some quando um provedor conecta
  const [providerHintVisible, setProviderHintVisible] = useState(false)
  const noProvider = useNoProviderConnected()
  const providersLoading = useProvidersLoading()

  // Conectou um provedor (ou a inicialização revelou que existem) → card some
  useEffect(() => {
    if (!noProvider) setProviderHintVisible(false)
  }, [noProvider])

  // O convite entra DEPOIS da persona e DEPOIS da abertura falada. Na abertura
  // ela acorda aos 650ms (ver a transição de entrada) e, ao voltar do chat,
  // surge aos 650ms e acorda aos 800ms. As três falas começam em seguida e
  // terminam em INTRO_TOTAL_MS — só então o convite e o resto entram.
  // Sem persona na tela de boas-vindas, ou com movimento reduzido, não há por
  // que esperar.
  useEffect(() => {
    if (hasChat) {
      setIntroVisible(false)
      return
    }
    if (!personaOnWelcome) {
      setIntroVisible(true)
      return
    }
    // Os provedores ainda estão carregando: não se sabe se falta algum.
    // Decidir agora faria o título aparecer e depois sumir, quando o
    // loading terminasse.
    if (providersLoading) return
    // A abertura falada (as três palavras girando) é da primeira entrada:
    // acontece só quando falta provedor. Com provedor conectado, o título
    // entra direto, sem as palavras.
    if (!noProvider) {
      setIntroVisible(true)
      return
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const id = setTimeout(() => setIntroVisible(true), reduced ? 0 : INTRO_TOTAL_MS)
    return () => clearTimeout(id)
  }, [hasChat, personaOnWelcome, providersLoading, noProvider])

  // Se o Rive quebrou, a persona some; trocar de chat (ou abrir um novo) é a
  // hora de tentar trazê-la de volta com um wasm novo
  useEffect(() => {
    retryPersona()
  }, [session?.id])

  useEffect(() => {
    // Decodifica o WAV de entrada durante o carregamento (idempotente), para
    // o áudio estar pronto quando o despertar de 650ms acontecer.
    void prepareEntranceSound()
    const wasChatting = prevHasChat.current
    prevHasChat.current = hasChat
    const timers: ReturnType<typeof setTimeout>[] = []

    if (hasChat && !wasChatting) {
      // Entrando no chat: o caminho da saída, ao contrário e nos mesmos tempos —
      // o centro fecha (50ms) e sai (550ms); o topo nasce dormindo só depois
      // que o centro terminou de fechar (650ms) e acorda 700ms depois
      // (1350ms); as mensagens entram 150ms depois de o centro sair. Com o
      // topo nascendo aos 300ms, ele aparecia com o centro ainda fechando — um
      // bicho de cada lado ao mesmo tempo.
      setCenterVisible(true)
      setCenterPersonaVisible(true)
      setDisplayCenterState("idle")
      timers.push(setTimeout(() => setDisplayCenterState("asleep"), 50))
      timers.push(setTimeout(() => { setCenterVisible(false); setCenterPersonaVisible(false) }, 550))
      timers.push(setTimeout(() => {
        setDisplayTopState("asleep")
        setTopOpaque(true)
        setTopVisible(true)
      }, 650))
      timers.push(setTimeout(() => setChatVisible(true), 700))
      timers.push(setTimeout(() => setDisplayTopState(isBusyRef.current ? "thinking" : "idle"), 1350))
    } else if (!hasChat && wasChatting) {
      // Saindo do chat: a MESMA animação da entrada, com as personas trocando
      // de papel. O topo faz o que o centro faz na entrada — dorme aos 50ms e
      // some com fade de 300ms a partir dos 550ms (invisível aos 850ms; o fim
      // da animação de dormir, que dura 1000ms, fica escondido no fade, como
      // na entrada) — e só desmonta depois do fade. O centro surge de uma vez
      // aos 650ms, dormindo, como o topo na entrada, mas acorda antes: aos
      // 800ms em vez de 1350ms (o primeiro brilho sai ~125ms depois, quando o
      // fade do topo acabou). Dormindo, a persona não desenha nada (medido
      // no canvas) — ela só aparece ao acordar. Na entrada o olho está no chat
      // e o atraso não se nota; aqui o centro é o foco da tela, e acordar aos
      // 1350ms deixava um buraco vazio acima do texto depois de o topo sumir.
      setChatVisible(false)
      setDisplayTopState(isBusyRef.current ? "thinking" : "idle")
      timers.push(setTimeout(() => setDisplayTopState("asleep"), 50))
      timers.push(setTimeout(() => setTopOpaque(false), 550))
      timers.push(setTimeout(() => setTopVisible(false), 900))
      setCenterVisible(true)
      setCenterPersonaVisible(false)
      setDisplayCenterState("asleep")
      timers.push(setTimeout(() => setCenterPersonaVisible(true), 650))
      timers.push(setTimeout(() => setDisplayCenterState("idle"), 800))
    } else if (hasChat) {
      // Permanece no chat (isBusy mudou durante a transição de entrada e
      // cancelou os timers): convergem para o estado final — chat visível e
      // centro oculto. Sem isso, o estado vazio (texto + sugestões) fica
      // preso com opacidade total, aparecendo como "background" do chat.
      setChatVisible(true)
      setCenterVisible(false)
      setCenterPersonaVisible(false)
      // O topo também: a entrada acima só o monta aos 650ms, e se o isBusy mudar
      // antes disso é este ramo que termina a transição — sem esta linha a
      // persona do topo não apareceria.
      setTopOpaque(true)
      setTopVisible(true)
      setDisplayTopState(isBusyRef.current ? "thinking" : "idle")
    } else {
      // Permanece sem chat (isBusy mudou durante a saída do chat) — garante
      // o estado final: tudo do centro visível, topo oculto e persona acordada.
      setCenterVisible(true)
      setCenterPersonaVisible(true)
      if (isInitialLaunch && !entranceWakeDone) {
        // Abertura do app: a transição sleep → idle acontece 650ms depois da
        // montagem, e o som de entrada (já decodificado durante o carregamento)
        // é agendado neste mesmo callback — os dois começam juntos.
        timers.push(setTimeout(() => {
          entranceWakeDone = true
          playEntranceSound()
          setDisplayCenterState("idle")
        }, 650))
      } else {
        setDisplayCenterState("idle")
      }
      setTopOpaque(false)
      setTopVisible(false)
    }

    return () => timers.forEach(clearTimeout)
  }, [hasChat, isBusy])

  // A voz em curso ganha dos estados do chat: com o áudio saindo a persona fala,
  // com o microfone aberto ela escuta. Sem voz, valem as animações de sempre.
  const voiceState = voiceActivityState(voiceActivity)
  const centerPersonaState = voiceState ?? displayCenterState
  const topPersonaState = voiceState ?? displayTopState
  const showTopPersona = topVisible && !simpleMode && personaInChat && !embedded

  // O nome é aprendido na conversa — nunca lido do sistema operacional. Só
  // grava quando a pessoa DIZ o nome ("meu nome é X", "me chama de X"); o
  // campo nas Preferências é a saída para corrigir ou apagar.
  const rememberUserName = useCallback((text: string) => {
    const detected = detectUserName(text)
    if (detected) useAppSettings.getState().update({ userName: detected })
  }, [])

  const handleChatSend = useCallback(
    (text: string, options: SendMessageOptions, files?: FilePart[]) => {
      rememberUserName(text)
      return sendMessage("chat", text, { options, sessionId, files })
    },
    [sendMessage, sessionId, rememberUserName],
  )

  const handleCodeSend = useCallback(
    (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[], files?: FilePart[]) => {
      rememberUserName(text)
      return sendMessage("code", text, { options, directory, extraDirectories, sessionId, files })
    },
    [sendMessage, sessionId, rememberUserName],
  )

  const handleStop = useCallback(() => {
    if (session) stopStreaming(session.id)
  }, [session, stopStreaming])

  const { t } = useTranslation()
  const openSettings = useSettingsUi((s) => s.openSettings)

  // A abertura falada: ocupa o lugar do título e sai quando o convite entra.
  const introGreetings = [
    t("chat.empty.greetingHello"),
    t("chat.empty.greetingWho"),
    t("chat.empty.greetingRole"),
  ]

  // A saudação está FIXA por enquanto: sempre "Pronto para começar?", nunca
  // "Olá, {nome}". A lógica do nome continua viva em volta — aprendida na
  // conversa, salva nas Preferências e injetada no system prompt — só a tela
  // inicial ainda não a usa. Para religar, o `title` volta a escolher entre
  // `chat.empty.hello` (quando houver `userName`) e `startTitle`.
  //
  // O que segue variando é informação funcional, não saudação: sem provedor o
  // subtítulo explica o bloqueio e o botão aparece; com provedor não há o que
  // explicar.
  const showProviderSetup = noProvider

  const baseSubtitle = viewMode === "chat" ? t("chat.empty.chatSubtitle") : t("chat.empty.codeSubtitle")
  const emptyState = {
    title: t("chat.empty.startTitle"),
    subtitle: showProviderSetup ? t("chat.empty.providerSubtitle") : baseSubtitle,
    cta: showProviderSetup ? (t("chat.empty.providerCta") as string | null) : (null as string | null),
  }

  // --- Sugestões da abertura -------------------------------------------------
  // Três pills: retomar o que ficou aberto, e duas capacidades — priorizando a
  // família que a pessoa nunca produziu (motion, áudio, vídeo), que é
  // exatamente o que fica escondido atrás da conversa.
  const sessions = useSessionStore((s) => s.sessions)
  const [usedKinds, setUsedKinds] = useState<MediaKind[]>([])
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [capabilitiesSeen, setCapabilitiesSeen] = useState(() => {
    try {
      return window.localStorage.getItem(CAPABILITIES_SEEN_KEY) === "1"
    } catch {
      return false
    }
  })

  // O que a galeria já tem decide qual capacidade é novidade. Uma leitura por
  // montagem; se falhar, a rotação por dia continua funcionando sozinha.
  useEffect(() => {
    let alive = true
    mediaApi
      .list()
      .then((entries) => {
        if (alive) setUsedKinds([...new Set(entries.map((entry) => mediaKind(entry)))])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const startDay = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  }, [])

  const lastSessionForStart = useMemo(() => {
    const directory = folders[0]
    let recent: (typeof sessions)[number] | undefined
    for (const item of sessions) {
      if (item.archived || item.parentId || item.mode !== viewMode) continue
      // No código, retomar só faz sentido na pasta aberta: uma sessão de outro
      // repositório levaria a um contexto que não é o desta tela.
      if (viewMode === "code" && item.directory !== directory) continue
      // A sessão aberta não é "retomar" — mas ela não derruba o convite: ele
      // passa para a sessão anterior, que é justamente o que a pessoa quer
      // quando está num chat novo e vazio.
      if (item.id === session?.id) continue
      if (!recent || item.updatedAt > recent.updatedAt) recent = item
    }
    if (!recent) return undefined
    return { id: recent.id, title: recent.title, mode: recent.mode }
  }, [sessions, viewMode, folders, session?.id])

  // Recurso desligado é tool ausente no turno: a pill pularia para uma
  // promessa vazia. O painel "O que o Orbit faz?" é quem oferece o botão de
  // ativar — aqui a linha simplesmente não aparece.
  const ttsEnabled = useAppSettings((s) => s.settings.voice?.tts?.enabled ?? VOICE_DEFAULTS.tts.enabled)
  const sttEnabled = useAppSettings((s) => s.settings.voice?.stt?.enabled ?? VOICE_DEFAULTS.stt.enabled)
  const browserToolsEnabled = useAppSettings((s) => s.settings.browser.agentTools)

  const startSuggestions = useMemo(
    () =>
      showProviderSetup
        ? []
        : buildStartSuggestions(
            {
              mode: viewMode,
              directory: folders[0],
              lastSession: lastSessionForStart,
              usedKinds,
              features: { tts: ttsEnabled, stt: sttEnabled, browser: browserToolsEnabled },
              day: startDay,
            },
            t,
          ),
    [
      showProviderSetup,
      viewMode,
      folders,
      lastSessionForStart,
      usedKinds,
      ttsEnabled,
      sttEnabled,
      browserToolsEnabled,
      startDay,
      t,
    ],
  )

  /**
   * A lista da abertura congela no instante em que ela começa a sair.
   *
   * Entrar numa sessão troca a sessão ativa no mesmo tick em que o centro
   * começa o fade de saída — e o "Retomar" daquela sessão deixaria de existir
   * ali mesmo. O card sumia com a tela ainda visível, e as pills reflowavam
   * na frente de quem acabou de clicar. Enquanto a abertura está de pé, o
   * conteúdo não muda; ela só é recalculada quando a tela volta ao repouso.
   */
  const [welcomeSuggestions, setWelcomeSuggestions] = useState(startSuggestions)
  useEffect(() => {
    if (!hasChat) setWelcomeSuggestions(startSuggestions)
  }, [hasChat, startSuggestions])

  const handleStartSuggestion = useCallback(
    (suggestion: StartSuggestion) => {
      if (suggestion.action.kind === "fill") {
        // Preenche, não envia: quem aperta Enter é a pessoa.
        useDraftInput.getState().setDraft(session?.id ?? null, suggestion.action.text)
        return
      }
      if (suggestion.action.mode !== mode) setMode(suggestion.action.mode)
      void selectSession(suggestion.action.mode, suggestion.action.sessionId)
    },
    [mode, session?.id, setMode, selectSession],
  )

  const openCapabilities = useCallback(() => {
    setCapabilitiesOpen(true)
    setCapabilitiesSeen(true)
    try {
      window.localStorage.setItem(CAPABILITIES_SEEN_KEY, "1")
    } catch {
      // localStorage indisponível não pode impedir o painel de abrir
    }
  }, [])

  const handleCapabilityPick = useCallback(
    (example: string) => {
      useDraftInput.getState().setDraft(session?.id ?? null, example)
      setCapabilitiesOpen(false)
    },
    [session?.id],
  )

  // Cada linha da abertura entra sozinha, depois da persona: título →
  // subtítulo → botão. O atraso vive no transition-delay porque a transição
  // já roda no CSS; ao sair da tela os atrasos voltam a zero e tudo some junto.
  // 1s por linha e uma curva que desacelera devagar (não o `ease-out` curto)
  // é o que faz a entrada parecer lenta em vez de apressada.
  const introLine = `transition-all duration-1000 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
    introVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1.5"
  }`

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {/* Breadcrumb de chat orquestrado: pai > worker */}
      {session?.parentId && !embedded && (
        <div className="z-30 flex items-center gap-1 px-4 pt-2 text-xs text-muted-foreground">
          <button
            type="button"
            className="max-w-48 truncate transition-colors hover:text-foreground"
            onClick={() => {
              // Acompanha o modo do pai para a sidebar destacar a sessão certa
              const targetMode = parentSession?.mode ?? viewMode
              if (targetMode !== mode) setMode(targetMode)
              void selectSession(targetMode, session.parentId!)
            }}
          >
            {parentSession?.title ?? "Chat principal"}
          </button>
          <ChevronRight className="size-3 shrink-0" />
          <span className="max-w-64 truncate text-foreground">{session.title}</span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {showTopPersona && (
          <div
            className="absolute left-1/2 z-40 -translate-x-1/2 transition-opacity duration-300 ease-in-out"
            style={{
              top: "-1.7rem",
              width: "4rem",
              height: "4rem",
              opacity: topOpaque ? 1 : 0,
            }}
          >
            <Persona state={topPersonaState} className="!size-full" />
          </div>
        )}

        <div
          className={`flex h-full items-start justify-center overflow-y-auto transition-all duration-300 ease-in-out ${
            centerVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex flex-col items-center gap-4 pt-40">
            {personaOnWelcome && (
              <div
                className="flex justify-center transition-all ease-in-out"
                style={{
                  width: "8rem",
                  height: "8rem",
                  opacity: centerPersonaVisible ? 1 : 0,
                  // Surge de uma vez ao voltar para a tela de novo chat (como
                  // o topo surge ao entrar no chat) e sai com fade ao entrar.
                  transitionDuration: centerPersonaVisible ? "0ms" : "500ms",
                }}
              >
                <Persona state={centerPersonaState} className="!size-full" />
              </div>
            )}
            <div className="flex flex-col items-center gap-6">
              <div className="flex flex-col items-center gap-2">
                <div className="relative flex items-center justify-center">
                  <p className={`whitespace-nowrap text-center text-lg font-medium text-foreground ${introLine}`}>
                    {emptyState.title}
                  </p>
                  {!introVisible && !hasChat && showProviderSetup && (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 left-1/2 grid w-max -translate-x-1/2 place-items-center"
                    >
                      {introGreetings.map((line, i) => (
                        <span
                          key={line}
                          className="intro-greeting col-start-1 row-start-1 whitespace-nowrap text-center text-lg font-medium text-foreground"
                          style={{
                            animationDelay: `${INTRO_START_MS + i * INTRO_STEP_MS}ms`,
                            animationDuration: `${INTRO_LINE_MS}ms`,
                          }}
                        >
                          {line}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <p
                  className={`max-w-md text-center text-sm text-muted-foreground ${introLine}`}
                  style={{ transitionDelay: introVisible ? `${INTRO_STEP_MS}ms` : "0ms" }}
                >
                  {emptyState.subtitle}
                </p>
                {emptyState.cta && (
                  <span
                    className={`relative mt-1 inline-flex ${introLine}`}
                    style={{ transitionDelay: introVisible ? `${INTRO_STEP_MS}ms` : "0ms" }}
                  >
                    {/* Linha fina que nasce na borda do botão e se abre para
                        fora, devagar: chama o olho para o único bloqueio real
                        do app sem piscar o botão. Quem pediu menos movimento ao
                        sistema não vê a pulsação. */}
                    <span
                      aria-hidden
                      className="provider-pulse-ring pointer-events-none absolute inset-0 rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={() => openSettings("providers")}
                      className="relative inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <Plug className="size-4" />
                      {emptyState.cta}
                    </button>
                  </span>
                )}
              </div>
              {!showProviderSetup && (
                /* As sugestões entram depois do subtítulo, no mesmo passo: sem
                    isto elas apareciam fixas enquanto a persona ainda
                    dormia, e a tela ficava com os botões antes de qualquer
                    texto. */
                <div
                  className={`flex w-full max-w-md flex-col items-center gap-1 ${introLine}`}
                  style={{ transitionDelay: introVisible ? `${INTRO_STEP_MS * 2}ms` : "0ms" }}
                >
                  {welcomeSuggestions.length > 0 && (
                    <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                      {welcomeSuggestions.map((suggestion) => (
                        <Suggestion
                          key={suggestion.id}
                          suggestion={suggestion.label}
                          onClick={() => handleStartSuggestion(suggestion)}
                          className={cn(
                            "h-auto justify-start gap-2 py-1.5 text-left leading-snug whitespace-normal",
                            suggestion.action.kind === "open" && "sm:col-span-2",
                          )}
                          title={suggestion.action.kind === "fill" ? suggestion.action.text : undefined}
                        >
                          {suggestion.action.kind === "open" ? (
                            <History className="size-3.5 shrink-0" />
                          ) : suggestion.capability ? (
                            <CapabilityIcon capability={suggestion.capability} className="size-3.5 shrink-0" />
                          ) : null}
                          <span className="min-w-0 flex-1">{suggestion.label}</span>
                          {/* Capacidade de uma família que a pessoa ainda não
                              produziu — o convite é para experimentar, não um
                              selo de novidade. */}
                          {suggestion.fresh && (
                            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
                          )}
                        </Suggestion>
                      ))}
                    </div>
                  )}
                  {/* Meta-navegação, não uma quarta sugestão: o mapa das
                      capacidades é pequeno de propósito e não compete com as
                      pills. */}
                  <button
                    type="button"
                    onClick={openCapabilities}
                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Sparkles className="size-3.5" />
                    {t("chat.start.link")}
                    {!capabilitiesSeen && (
                      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                </div>
              )}
              <CapabilitiesDialog
                open={capabilitiesOpen}
                onOpenChange={setCapabilitiesOpen}
                mode={viewMode}
                onPick={handleCapabilityPick}
              />
            </div>
          </div>
        </div>

        <div
          className={`absolute inset-0 flex flex-col transition-all duration-500 ease-in-out ${
            chatVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className={`flex min-h-0 flex-1 flex-col ${showTopPersona ? "pt-6" : "pt-2"}`}>
            {/* Véu que dissolve a conversa por baixo da persona flutuante. Ele
                existe POR CAUSA dela: sem a persona no topo não há o que
                esconder, e a faixa vira só três centímetros de nada comendo o
                começo da lista. Mesma condição do respiro acima. */}
            {showTopPersona && (
              <div className="pointer-events-none sticky top-0 z-10 h-12 bg-linear-to-b to-transparent" style={{ backgroundImage: 'linear-gradient(to bottom, var(--panel-bg, var(--background)), transparent)' }} />
            )}
            {/* Vale nos dois modos: a conversa de código também tem histórico
                para procurar, e o menu do header agora a oferece lá. */}
            {chatSearchOpen && <ChatMessageSearchBar messages={messages} />}
            <ChatMessages
              messages={messages}
              historyPending={historyPending}
              isBusy={isBusy}
              busyLabel={
                status === "fallback" && fallback
                  ? t(fallback.retry ? "chat.retryingStatus" : "chat.fallbackStatus", {
                      current: fallback.current,
                      total: fallback.total,
                    })
                  : undefined
              }
              mode={viewMode}
              sessionId={session?.id}
              sendMessage={sendMessage}
              planIds={planMsgIds}
              planReview={planReview}
              plan={plan}
            />
          </div>
        </div>
      </div>
      {/* Projeto novo no modo código: card oferece o /init automático */}
      {viewMode === "code" && initDirectory && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <InitProjectCard directory={initDirectory} sessionId={session?.id} />
        </div>
      )}
      {/* Revert ativo: barra com alterações desfeitas + botão de desfazer */}
      {session?.revert && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <RevertBar session={session} />
        </div>
      )}
      {/* Plano de orquestração proposto — aprovar/rejeitar */}
      {session && plan && plan.status === "proposed" && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <OrchestrationPlanCard sessionId={session.id} plan={plan} />
        </div>
      )}
      {/* Plano de orquestração em execução/concluído — progresso das tarefas.
          O mode é fixo: worker de orquestração roda sempre na pasta de trabalho. */}
      {session && plan && (plan.status === "approved" || plan.status === "running" || plan.status === "done") && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <TaskProgress
            tasks={plan.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              mode: "code" as const,
              fase: t.fase,
              extra: t.extra,
              revisions: t.revisions,
              nota: t.notaRevisao,
            }))}
            acompanhamento={plan.revisao}
            onJuntarDeNovo={() => chatApi.juntarOrquestracao(session.id)}
            title={t("chat.orchestrationTitle")}
            defaultExpanded={plan.status !== "done"}
            onDismiss={plan.status === "done" ? () => useSessionStore.getState().dismissOrchestration(session.id) : undefined}
          />
        </div>
      )}
      {/* Imagem anexada com modelo sem visão e modo Visão desligado */}
      <VisionHintCard sessionId={session?.id} />
      {/* Tentativa de envio sem nenhum provedor configurado (primeira execução) */}
      <ProviderHintCard visible={providerHintVisible} onDismiss={() => setProviderHintVisible(false)} />
      {/* Pedidos aguardando resposta (permissão / question), inline acima do input.
          Itens com batchId (workers em lote) agrupam num card único de submit único. */}
      {pendingAsks.length > 0 && (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 pb-2">
          {pendingAsks
            .filter((a) => !a.batchId)
            .map((ask) => (
              <AskCard key={ask.requestId} ask={ask} sessionId={session?.id} />
            ))}
          {[...new Set(pendingAsks.map((a) => a.batchId).filter(Boolean))].map((batchId) => (
            <AskCardBatch
              key={batchId}
              items={pendingAsks.filter((a) => a.batchId === batchId)}
            />
          ))}
        </div>
      )}
      {viewMode === "chat" ? (
        <ChatInput
          onSubmit={handleChatSend}
          status={status}
          onStop={handleStop}
          sessionId={session?.id}
          onProviderBlocked={() => setProviderHintVisible(true)}
        />
      ) : (
        <CodeInput
          onSubmit={handleCodeSend}
          status={status}
          onStop={handleStop}
          hasMessages={hasChat}
          sessionId={session?.id}
          onProviderBlocked={() => setProviderHintVisible(true)}
        />
      )}
    </div>
  )
}
