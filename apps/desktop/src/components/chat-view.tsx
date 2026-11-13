import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom"
import { useTranslation } from "react-i18next"
import { ArrowDown, HelpCircle, History, Plug, Sparkles } from "lucide-react"
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
import { chatApi, mediaApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import { mediaKind, type MediaKind } from "@shared/media"
import { CapabilitiesDialog } from "@/src/components/capabilities-dialog"
import { CapabilityIcon } from "@/src/components/capability-icon"
import { buildStartSuggestions, type StartSuggestion } from "@/src/lib/start-suggestions"
import { useDraftInput } from "@/src/stores/draft-input"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { Suggestion } from "@/src/components/ai/suggestion"
import { MessageItem } from "@/src/components/messages/message-item"
import { SummaryCard } from "@/src/components/messages/summary-card"
import { CompactionSuggestionCard } from "@/src/components/compaction-suggestion-card"
import { OrchestrationPlanCard } from "@/src/components/orchestration-plan-card"
import { TaskProgress } from "@/src/components/task-progress"
import { PlanReviewCard } from "@/src/components/plan-review-card"
import { ComputerThumbCard } from "@/src/components/computer-chip"
import { InitProjectCard } from "@/src/components/init-project-card"
import { RevertBar } from "@/src/components/revert-bar"
import { MessageReplySelection } from "@/src/components/message-reply-selection"
import { DateSeparator, isNewDay } from "@/src/components/messages/date-separator"
import { ChatMessageSearchBar } from "@/src/components/chat-message-search-bar"
import { useChatSearchStore } from "@/src/stores/chat-search-store"
import { useMotionBundleAnchors } from "@/src/stores/motion-bundles-store"
import { messageBody } from "@/src/lib/message-utils"
import { PAGE_TURNS, defaultWindowStart, turnStart, windowStartFor } from "@/src/lib/message-window"
import { registerMessageRevealer, revealMessage } from "@/src/lib/message-jump"
import { playEntranceSound, prepareEntranceSound } from "@/src/lib/entrance-sound"
import { isRoutineSession } from "@/src/lib/last-chat"
import { sameFolders, sessionFolders } from "@/src/lib/session-folders"
import { useActiveSession, useSessionStatus, useSessionStore, type SendConfig } from "@/src/stores/session-store"
import { foldersAfterSwitch, useWorktreeStore } from "@/src/stores/worktree-store"
import { useProviderStore, useNoProviderConnected, useProvidersLoading } from "@/src/stores/provider-store"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useSimpleMode } from "@/src/stores/simple-prefs"
import { useAppSettings } from "@/src/stores/app-settings"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { pickWelcomeTitle } from "@shared/welcome-title"
import { VOICE_DEFAULTS } from "@shared/voice"

// Stable references for the zustand selectors (avoids the getSnapshot loop)
const NO_MESSAGES: ChatMessage[] = []
const NO_ASKS: never[] = []


/**
 * Opening of the welcome screen: three lines before the invitation.
 *
 * INTRO_START_MS is the delay the first line inherits from the old "Ready to
 * start?" — the time the persona takes to wake up. From there on everything moves
 * in the same step (INTRO_STEP_MS): each line starts one step after the
 * previous one, the final invitation enters one step after the last, and the subtitle and the
 * button enter one step after the invitation. Each line lasts INTRO_LINE_MS, a
 * little more than the step — that is what makes the previous one still be leaving when the
 * next one enters.
 *
 * INTRO_TOTAL_MS is when the invitation takes the place of the lines; it is the delay that the
 * opening effect uses.
 */
const INTRO_START_MS = 1200
const INTRO_STEP_MS = 1400
const INTRO_LINE_MS = 1500
/** How many lines come before the invitation. */
const INTRO_STEPS = 3
const INTRO_TOTAL_MS = INTRO_START_MS + INTRO_STEP_MS * INTRO_STEPS



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
 * Top of the message window: mounts the earlier turns when the person
 * scrolls close to it. It only reacts after they left the end of the conversation — when
 * opening the chat the top is on screen before the initial scroll goes down, and
 * loading there would mount the whole history, which is what the window avoids.
 * It also loads when the window does not even fill the screen (there is nothing to scroll).
 */
function EarlierMessages({ hiddenCount, onLoad, paused }: {
  hiddenCount: number
  onLoad: () => void
  /** During a jump to a message: loading here would disturb the scroll in the middle
   *  of the scroll to the target. */
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

function ChatMessages({ messages, historyPending, isBusy, busyLabel, mode, sessionId, sendMessage, planIds, planReview, plan, footer, underVeil, dateVariant = "pill" }: {
  messages: ChatMessage[]
  /** The session history has not arrived from disk yet. */
  historyPending: boolean
  isBusy: boolean
  busyLabel?: string
  mode: "chat" | "code"
  sessionId?: string
  /** There is a veil at the top (persona visible): only then can the conversation rise under
   *  it. Without the veil, raising the conversation puts it over the header, which is
   *  transparent on purpose (the persona overflows into it). */
  underVeil?: boolean
  sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
  planIds: Set<string>
  planReview: PlanReview | undefined
  plan?: OrchestrationPlan | undefined
  /** Cards that belong to the conversation (agent request, revert, orchestration)
   *  and therefore scroll with it, instead of taking the fixed strip above the input. */
  footer?: ReactNode
  /** Date marker between days: the quiet line of the routine chat, or the usual pill. */
  dateVariant?: "pill" | "line"
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

  // ── Window: only the last turns stay mounted (see message-window.ts) ──
  // Keyed by the ID of the first message, not by the index: new messages
  // arrive at the end and cannot shift the window. It stays fixed once defined
  // (the growing chat does not unmount what is above); switching session or the
  // message disappearing (revert, compaction) returns to the default.
  const [windowState, setWindowState] = useState<{ sessionId?: string; startId: string | null }>({
    sessionId,
    startId: null,
  })
  // State updates during render (derived state): React
  // discards this render and redoes it with the new value, without going through the DOM.
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
  /** Scroll measurements before mounting turns above — to keep on screen what
   *  the person was reading when the content grows on top. */
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const startIndexRef = useRef(startIndex)
  startIndexRef.current = startIndex
  /** Until when the automatic loading of the top stays halted (jump in progress). */
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
    // Chromium may already have compensated by itself (scroll anchoring); it only touches
    // it if the position is not the expected one.
    const expected = anchor.top + (scroller.scrollHeight - anchor.height)
    if (Math.abs(scroller.scrollTop - expected) > 1) scroller.scrollTop = expected
  }, [startIndex])

  // Opens at the end BEFORE the first frame: StickToBottom only goes down in a
  // requestAnimationFrame, and until then the chat appeared at the top for an instant.
  // Runs when the conversation mounts (session switch or history that arrived).
  useLayoutEffect(() => {
    if (historyPending) return
    const scroller = stickRef.current?.scrollRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [sessionId, historyPending])

  // The chat area also changes height without the content changing: the header
  // persona enters with the veil (the chat shrinks ~64px), the text field grows,
  // a card appears above the input. StickToBottom only observes the content,
  // so in those cases the end of the conversation stayed hidden underneath. Stuck to the
  // end before the change, it stays stuck after it.
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

  // Jump to a message outside the window (search, browser, gallery):
  // extends the window up to its turn. stopScroll releases the end lock —
  // otherwise the new content above would pull the conversation back
  // down while the search tries to scroll to the message.
  useEffect(() => {
    return registerMessageRevealer((messageId) => {
      const list = messagesRef.current
      const index = list.findIndex((m) => m.id === messageId)
      if (index < 0) return false
      if (index < startIndexRef.current) {
        stickRef.current?.stopScroll()
        jumpUntilRef.current = Date.now() + 1500
        // Extra turns above the target: the top of the window stays far from it, and
        // scrolling a little up after the jump does not hit the limit.
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
    // Re-observes when the window grows: the questions just mounted at the top
    // also count for the browser highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMsgItems.map((i) => i.id).join(","), startIndex])

  const handleNavSelect = useCallback(async (id: string) => {
    const el = await revealMessage(id)
    if (!el) return
    // Scrolls the real scroll container (StickToBottom's inner div), which sits
    // under an ancestor with overflow-y-hidden — scrollIntoView does not always scroll
    // the right container in this structure.
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

  // Without the history, the conversation does not mount. Mounted empty, the first measurement
  // of StickToBottom (the one that scrolls without animating) was spent on the empty list, and the
  // history arriving later became "content grew": the smooth spring went down
  // the whole chat from the top to the end, in plain sight.
  if (historyPending) return <div className="relative flex-1" />

  return (
    // initial="instant": the chat opens already at the end, without scrolling through everything to get there.
    <Conversation key={sessionId ?? "no-session"} contextRef={stickRef} initial="instant" className={cn("relative flex-1", underVeil && "-mt-10")}>
      <ConversationContent className="mx-auto w-full max-w-3xl">
        {startIndex > 0 && (
          // key by the window: every load remounts the observer, which re-evaluates on
          // the spot whether the top is still near (fast scrolling asks for more than one)
          <EarlierMessages key={messages[startIndex].id} hiddenCount={startIndex} onLoad={loadEarlier} paused={autoLoadPaused} />
        )}
        {visibleMessages.map((msg, visibleIndex) => {
          // Index in the whole history: the date separator and the retry look at the
          // real previous message, mounted or not.
          const index = startIndex + visibleIndex
          const showSeparator = isNewDay(messages[index - 1]?.createdAt, msg.createdAt)

          if (msg.summary) {
            return (
              <div key={msg.id}>
                {showSeparator && <DateSeparator timestamp={msg.createdAt} variant={dateVariant} />}
                <SummaryCard message={msg} />
              </div>
            )
          }

          const isLast = msg.id === lastAssistantId
          const finished = msg.role !== "assistant" || !(isLast && isBusy)
          const waiting = msg.role === "assistant" && isLast && isBusy && msg.parts.length === 0

          return (
            <div key={msg.id}>
              {showSeparator && <DateSeparator timestamp={msg.createdAt} variant={dateVariant} />}
              {/* A message the renderer does not know how to draw — usually
                  data recorded by a previous version — becomes a notice in
                  its place. Before, it erased the whole conversation. */}
              <ErrorBoundary
                label={`message ${msg.id}`}
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
          // max-w-2xl to align with the input: the conversation is max-w-3xl, and the
          // card was wider than the message box right below it.
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
        {footer}
      </ConversationContent>
      <ConversationScrollButton />
      <UserMessageNav items={userMsgItems} activeId={activeUserMsgId} onSelect={handleNavSelect} planIds={planIds} />
      {/* Select an excerpt and reply only to it — inside the Conversation
          because it is its scroll element that delimits the valid area. */}
      <MessageReplySelection sessionId={sessionId} />
    </Conversation>
  )
}

// App opening: the central persona is born sleeping and wakes ~650ms after
// mounting. The entrance sound is played by the renderer (WebAudio) at this same
// instant — audio and persona start together (see src/lib/entrance-sound.ts).
// The flags are per module/process — later screen switches use the normal
// transition.
let entranceWakeDone = false
const isInitialLaunch = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("entrance")

/** The golden dot of the "What does Orbit do?" link disappears after the first time. */
const CAPABILITIES_SEEN_KEY = "orbit-capabilities-seen"

/** `embedded`: the chat is in a tab of the side panel. There the vertical space is
 *  short and the tab already says which chat it is, so the top persona goes away. */
export function ChatView({ sessionId, embedded = false, startScreen, hideFolders = false, hideInitCard = false, dateSeparator = "pill" }: {
  sessionId?: string
  embedded?: boolean
  /** The start screen of a chat with a meaning of its own (a routine): it replaces the
   *  generic greeting and its suggestions. */
  startScreen?: ReactNode
  /** The working folder belongs to whoever owns this chat (a routine): it is not chosen here. */
  hideFolders?: boolean
  /** No "/init" offer: the chat already has a folder and an owner. */
  hideInitCard?: boolean
  /** "line" is the quiet date of the routine chat. */
  dateSeparator?: "pill" | "line"
} = {}) {
  const { mode, setMode, folders, setFolders } = useWorkspace()
  const activeSession = useActiveSession(mode)
  const explicitSession = useSessionStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined,
  )
  const session = sessionId ? explicitSession : activeSession
  const viewMode = session?.mode ?? mode
  // Session fields read outside effects: the object identity changes on every
  // store update, and object dependencies would fire for nothing.
  const sessionDirectory = session?.directory
  const sessionExtraDirectories = session?.extraDirectories
  /** The routine's chat (and a run's session): its folder belongs to the routine, not the workspace. */
  const routineChat = isRoutineSession(session)
  const messages = useSessionStore((s) =>
    session ? s.messages[session.id] ?? NO_MESSAGES : NO_MESSAGES,
  )
  const status = useSessionStatus(session?.id)
  const fallback = useSessionStore((s) => (session ? s.fallback[session.id] : undefined))
  const plan = useSessionStore((s) => (session ? s.orchestration[session.id] : undefined))
  const planReview = useSessionStore((s) => (session ? s.planReviews[session.id] : undefined))
  const pendingAsks = useSessionStore((s) => (session ? s.pendingAsks[session.id] ?? NO_ASKS : NO_ASKS))
  const compactionSuggestion = useSessionStore((s) =>
    session ? s.compactionSuggestion[session.id] : undefined,
  )
  // IDs of user messages that generated plans — computed from the review + messages
  const planMsgIds = useMemo(() => {
    const ids = new Set<string>()
    if (!planReview || !session) return ids
    if (planReview.status !== "proposed" && planReview.status !== "implementing") return ids
    const idx = messages.findIndex((m) => m.id === planReview.messageId)
    if (idx > 0 && messages[idx - 1].role === "user") ids.add(messages[idx - 1].id)
    return ids
  }, [planReview, messages, session])
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const selectSession = useSessionStore((s) => s.selectSession)
  const initializeProviders = useProviderStore((s) => s.initialize)
  // The brain/simple default comes from the active modes preferences of the current mode
  const modeDefaults = useModelModePrefs((s) => (viewMode === "code" ? s.codeActiveModes : s.chatActiveModes))
  const simpleMode = useSimpleMode(session?.id, modeDefaults.simple)
  const chatSearchOpen = useChatSearchStore((s) => s.open)

  useEffect(() => {
    void initializeProviders()
  }, [initializeProviders])

  // Loads the history both for explicit views (workers/panel) and
  // for the main session. After a renderer reload, the status may come back
  // as streaming before the message list has been hydrated; without this
  // effect the UI stayed empty while the engine kept running.
  useEffect(() => {
    if (session?.id) void useSessionStore.getState().ensureMessages(session.id)
  }, [session?.id])

  // Closes the search on session switch so obsolete results are not left visible
  useEffect(() => {
    useChatSearchStore.getState().close()
  }, [session?.id])

  // Syncs the session folder (e.g. coming from mobile) with the workspace. Beyond
  // the chat switch, it follows the folder switch of the SAME session made outside
  // the screen — the agent moving the chat to another worktree (worktree_switch/create).
  // Without that, the next send would write the old folder back.
  //
  // The chat of a panel tab stays out: it has ITS OWN folders (the tab
  // header already persists them) and the workspace is the main window's — writing
  // to it would swap the folders of the chat on screen, and the next send
  // would record that swap in the wrong session.
  const prevSessionId = useRef(session?.id)
  const prevDirectory = useRef(session?.directory)
  useEffect(() => {
    if (embedded || viewMode !== "code" || !session?.directory) return
    const trocouChat = session.id !== prevSessionId.current
    const folderChanged = !trocouChat && session.directory !== prevDirectory.current
    prevSessionId.current = session.id
    prevDirectory.current = session.directory
    // A routine's chat works in the routine's own folder. It opens with that folder (chatFolders
    // reads it from the session), but the folder does not go to the workspace: the next NEW chat
    // keeps the folder of the last chat the person actually worked in.
    if (routineChat) return
    if (trocouChat) {
      setFolders([session.directory, ...(session.extraDirectories ?? [])])
    } else if (folderChanged && useSessionStore.getState().activeIds.code === session.id) {
      // Same session, folder swapped by the agent: the extras of the workspace stay
      // (including the ones attached after the last send) and go to the session.
      // Only in the active chat — the workspace is its own; a chat in the side panel does not
      // touch the folders of the screen.
      const remaining = foldersAfterSwitch(session.directory, folders)
      setFolders(remaining)
      useSessionStore.getState().setSessionDirectories(session.id, session.directory, remaining.slice(1))
    }
    if (trocouChat || folderChanged) {
      // A folder that arrived from outside may be a worktree: it registers its main
      // one so the sidebar groups the next chats in the right project.
      void useWorktreeStore.getState().resolveMain(session.directory)
    }
    // folders comes in only so the switch reads the current extras; changing only the folders
    // fires nothing (neither the chat nor the main folder of the session changed).
  }, [embedded, routineChat, session?.id, session?.directory, session?.extraDirectories, viewMode, setFolders, folders])

  // Attaching (or removing) a folder counts right away, and not only on the next send.
  //
  // The session on disk was only updated on send, so the association lived
  // only in the workspace (localStorage): closing the app — or opening another chat, which
  // restores the workspace from the session — undid what the person had
  // just attached. Here the list goes to the session on the same click, which is
  // what makes the folder stay "until it is removed".
  //
  // The ref keeps the list (and the chat) of the previous render. Switching chat
  // also swaps the list — and that list is the new session's, not an association
  // made now —, so it only counts as a change when the chat was already on screen.
  const chatSessionId = session?.id
  const previousFolders = useRef({ folders, sessionId: chatSessionId })
  useEffect(() => {
    const previous = previousFolders.current
    previousFolders.current = { folders, sessionId: chatSessionId }
    if (previous.sessionId !== chatSessionId) return
    const changed = previous.folders !== folders
    if (!changed || embedded || viewMode !== "code" || !chatSessionId) return
    const folderList = folders.filter(Boolean)
    if (folderList.length === 0) return
    const foldersOfSession = sessionFolders({ directory: sessionDirectory, extraDirectories: sessionExtraDirectories })
    if (sameFolders(foldersOfSession, folderList)) return
    useSessionStore.getState().setSessionDirectories(chatSessionId, folderList[0], folderList.slice(1))
  }, [folders, embedded, viewMode, chatSessionId, sessionDirectory, sessionExtraDirectories])

  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  // The files of the motion pieces of this conversation: the piece card in the chat reads
  // from here (and updates when the folder changes). The addresses say in which
  // MESSAGE each card lives — the first one that showed media of that piece.
  useMotionBundleAnchors(session?.id, messages, isBusy)
  // A session whose history has not arrived from disk counts as a conversation: without
  // that, switching chat went through the start screen (empty list for an
  // instant) and ran the exit and entrance animations before showing the
  // chosen chat.
  const historyPending = useSessionStore((s) => (session ? s.messages[session.id] === undefined : false))
  const hasChat = messages.length > 0 || historyPending
  const personaVisibility = useAppearanceStore((s) => s.personaVisibility)
  /** The floating one at the top goes over the conversation; the greeting one does not
   *  compete for space with anything. They are separate choices — see PersonaVisibility. */
  const personaInChat = showsPersonaInChat(personaVisibility)
  const personaOnWelcome = showsPersonaOnWelcome(personaVisibility)
  // Folders THIS chat uses. In a panel tab they are the ones of the tab session: the
  // workspace is the main window's, and using it here would send the turn to the
  // folder of the chat that is on screen. A routine's chat is the same: its folder belongs
  // to the routine, and the workspace keeps the folder the next NEW chat starts from.
  const ownFolders = embedded || routineChat
  const chatFolders = useMemo(
    () =>
      ownFolders && sessionDirectory
        ? sessionFolders({ directory: sessionDirectory, extraDirectories: sessionExtraDirectories })
        : folders,
    [ownFolders, folders, sessionDirectory, sessionExtraDirectories],
  )

  const handleFoldersChange = useCallback(
    (next: string[]) => {
      if (!ownFolders) {
        setFolders(next)
        return
      }
      // Panel tab / routine chat: the association belongs to the session, and only to it.
      if (!session?.id || next.length === 0) return
      useSessionStore.getState().setSessionDirectories(session.id, next[0], next.slice(1))
    },
    [ownFolders, session?.id, setFolders],
  )

  // Target folder of the init card: the session's or the one selected in FolderSelector
  const initDirectory = session?.directory ?? (viewMode === "code" ? chatFolders[0] : undefined)

  const prevHasChat = useRef(hasChat)
  const isBusyRef = useRef(isBusy)
  isBusyRef.current = isBusy

  // Voice in progress (TTS speech or dictation) — published by the buttons themselves in
  // `stores/voice-activity`, because the persona has no connection to them.
  const voiceActivity = useVoiceActivity()
  const [displayCenterState, setDisplayCenterState] = useState<PersonaState>("asleep")
  const [displayTopState, setDisplayTopState] = useState<PersonaState>(
    hasChat ? (isBusy ? "thinking" : "idle") : "asleep",
  )
  const [topVisible, setTopVisible] = useState(hasChat)
  /** Opacity of the top persona, separate from the mounting: on exit it disappears with
   *  a fade and only unmounts afterwards, when the sleeping animation has finished. */
  const [topOpaque, setTopOpaque] = useState(hasChat)
  const [centerVisible, setCenterVisible] = useState(!hasChat)
  const [centerPersonaVisible, setCenterPersonaVisible] = useState(!hasChat)
  const [chatVisible, setChatVisible] = useState(hasChat)
  /**
   * The invitation of the start screen enters AFTER the persona, not with it: side by
   * side in time the two compete and the screen looks like it blinked. In sequence, the
   * person sees Orbit first and the text right after.
   */
  const [introVisible, setIntroVisible] = useState(false)
  // Missing-provider card: appears when the user tries to send with no
  // provider configured (input or suggestion) and disappears when a provider connects
  const [providerHintVisible, setProviderHintVisible] = useState(false)
  const noProvider = useNoProviderConnected()
  const providersLoading = useProvidersLoading()

  // Pending chip: the request card now lives in the conversation, so it may
  // be out of sight while the person reads the history. The chip only appears
  // in that case — with the card in view it would be noise. It goes back to disappearing by itself
  // when the request is answered (then there is no pending item at all anymore).
  const pendingAsksRef = useRef<HTMLDivElement | null>(null)
  const [pendingAskVisible, setPendingAskVisible] = useState(true)
  const hasPendingAsks = pendingAsks.length > 0

  useEffect(() => {
    const el = pendingAsksRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => setPendingAskVisible(entry.isIntersecting),
      { threshold: 0.15 },
    )
    observer.observe(el)
    return () => observer.disconnect()
    // historyPending enters the deps: while the history does not arrive, the
    // conversation (and the footer with the card) is not mounted, and the ref is null.
  }, [hasPendingAsks, session?.id, historyPending])

  const revealPendingAsk = useCallback(() => {
    const el = pendingAsksRef.current
    if (!el) return
    // The real scroller is StickToBottom's inner div (the Conversation is
    // overflow-y-hidden) — the same path the search jump walks.
    let scroller = el.parentElement
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (overflowY === "auto" || overflowY === "scroll") break
      scroller = scroller.parentElement
    }
    if (!scroller) return
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })
  }, [])

  // A provider connected (or the initialization revealed there are some) → the card goes away
  useEffect(() => {
    if (!noProvider) setProviderHintVisible(false)
  }, [noProvider])

  // The invitation enters AFTER the persona and AFTER the spoken opening. On opening
  // it wakes at 650ms (see the entrance transition) and, coming back from the chat,
  // it appears at 650ms and wakes at 800ms. The three lines start right after and
  // end at INTRO_TOTAL_MS — only then do the invitation and the rest enter.
  // With no persona on the welcome screen, or with reduced motion, there is no
  // reason to wait.
  useEffect(() => {
    if (hasChat) {
      setIntroVisible(false)
      return
    }
    if (!personaOnWelcome) {
      setIntroVisible(true)
      return
    }
    // The providers are still loading: it is not known whether any is missing.
    // Deciding now would make the title appear and then disappear, when the
    // loading finished.
    if (providersLoading) return
    // The spoken opening (the three rotating words) belongs to the first entrance:
    // it happens only when a provider is missing. With a provider connected, the title
    // enters straight away, without the words.
    if (!noProvider) {
      setIntroVisible(true)
      return
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const id = setTimeout(() => setIntroVisible(true), reduced ? 0 : INTRO_TOTAL_MS)
    return () => clearTimeout(id)
  }, [hasChat, personaOnWelcome, providersLoading, noProvider])

  // If Rive broke, the persona goes away; switching chat (or opening a new one) is the
  // moment to try bringing it back with a new wasm
  useEffect(() => {
    retryPersona()
  }, [session?.id])

  useEffect(() => {
    // Decodes the entrance WAV during the loading (idempotent), so that
    // the audio is ready when the 650ms waking happens.
    void prepareEntranceSound()
    const wasChatting = prevHasChat.current
    prevHasChat.current = hasChat
    const timers: ReturnType<typeof setTimeout>[] = []

    if (hasChat && !wasChatting) {
      // Entering the chat: the exit path, backwards and in the same timings —
      // the center closes (50ms) and leaves (550ms); the top is born sleeping only after
      // the center finished closing (650ms) and wakes 700ms later
      // (1350ms); the messages enter 150ms after the center leaves. With the
      // top being born at 300ms, it appeared with the center still closing — one
      // critter on each side at the same time.
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
      // Leaving the chat: the SAME animation as the entrance, with the personas swapping
      // roles. The top does what the center does on entrance — it sleeps at 50ms and
      // disappears with a 300ms fade starting at 550ms (invisible at 850ms; the end
      // of the sleeping animation, which lasts 1000ms, stays hidden in the fade, as
      // on the entrance) — and only unmounts after the fade. The center appears all at once
      // at 650ms, sleeping, like the top on the entrance, but wakes earlier: at
      // 800ms instead of 1350ms (the first glow comes out ~125ms later, when the
      // top's fade is over). Sleeping, the persona draws nothing (measured
      // on the canvas) — it only appears on waking. On the entrance the eye is on the chat
      // and the delay is not noticed; here the center is the focus of the screen, and waking at
      // 1350ms left an empty hole above the text after the top disappeared.
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
      // Stays in the chat (isBusy changed during the entrance transition and
      // canceled the timers): they converge to the final state — chat visible and
      // center hidden. Without that, the empty state (text + suggestions) is left
      // stuck at full opacity, showing as the chat's "background".
      setChatVisible(true)
      setCenterVisible(false)
      setCenterPersonaVisible(false)
      // The top too: the entrance above only mounts it at 650ms, and if isBusy changes
      // before that it is this branch that ends the transition — without this line the
      // top persona would not appear.
      setTopOpaque(true)
      setTopVisible(true)
      setDisplayTopState(isBusyRef.current ? "thinking" : "idle")
    } else {
      // Stays without chat (isBusy changed during the chat exit) — guarantees
      // the final state: everything of the center visible, top hidden and persona awake.
      setCenterVisible(true)
      setCenterPersonaVisible(true)
      if (isInitialLaunch && !entranceWakeDone) {
        // App opening: the sleep → idle transition happens 650ms after
        // mounting, and the entrance sound (already decoded during the loading)
        // is scheduled in this same callback — the two start together.
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

  // The voice in progress beats the chat states: with the audio going out the persona speaks,
  // with the microphone open it listens. Without voice, the usual animations apply.
  const voiceState = voiceActivityState(voiceActivity)
  const centerPersonaState = voiceState ?? displayCenterState
  const topPersonaState = voiceState ?? displayTopState
  const showTopPersona = topVisible && !simpleMode && personaInChat && !embedded

  const handleChatSend = useCallback(
    (text: string, options: SendMessageOptions, files?: FilePart[]) => {
      return sendMessage("chat", text, { options, sessionId, files })
    },
    [sendMessage, sessionId],
  )

  const handleCodeSend = useCallback(
    (text: string, options: SendMessageOptions, directory: string, extraDirectories: string[], files?: FilePart[]) => {
      return sendMessage("code", text, { options, directory, extraDirectories, sessionId, files })
    },
    [sendMessage, sessionId],
  )

  const handleStop = useCallback(() => {
    if (session) stopStreaming(session.id)
  }, [session, stopStreaming])

  const { t } = useTranslation()
  const openSettings = useSettingsUi((s) => s.openSettings)

  // The spoken opening: it takes the place of the title and leaves when the invitation enters.
  const introGreetings = [
    t("chat.empty.greetingHello"),
    t("chat.empty.greetingWho"),
    t("chat.empty.greetingRole"),
  ]

  // The title is drawn on every app opening and depends on the mode and on the learned
  // name: in chat it greets (with the name, when it exists), in code it talks
  // about work. The draw is stable per process — see welcome-title.ts.
  //
  // The subtitle is what follows functional information: without a provider it explains the
  // block and the button appears; with a provider there is nothing to explain.
  const showProviderSetup = noProvider
  const userName = useAppSettings((s) => s.settings.userName)

  const baseSubtitle = viewMode === "chat" ? t("chat.empty.chatSubtitle") : t("chat.empty.codeSubtitle")
  const emptyState = {
    title: t(pickWelcomeTitle({ mode: viewMode, userName }), { name: userName ?? "" }),
    subtitle: showProviderSetup ? t("chat.empty.providerSubtitle") : baseSubtitle,
    cta: showProviderSetup ? (t("chat.empty.providerCta") as string | null) : (null as string | null),
  }

  // --- Opening suggestions ---------------------------------------------------
  // Three pills: resume what was left open, and two capabilities — prioritizing the
  // family the person never produced (motion, audio, video), which is
  // exactly what stays hidden behind the conversation.
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

  // What the gallery already has decides which capability is news. One reading per
  // mount; if it fails, the daily rotation keeps working on its own.
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
      // In code, resuming only makes sense in the open folder: a session of another
      // repository would lead to a context that is not this screen's.
      if (viewMode === "code" && item.directory !== directory) continue
      // The open session is not "resume" — but it does not take down the invitation: it
      // moves on to the previous session, which is exactly what the person wants
      // when they are in a new and empty chat.
      if (item.id === session?.id) continue
      if (!recent || item.updatedAt > recent.updatedAt) recent = item
    }
    if (!recent) return undefined
    return { id: recent.id, title: recent.title, mode: recent.mode }
  }, [sessions, viewMode, folders, session?.id])

  // A feature turned off is a tool missing from the turn: the pill would jump to an
  // empty promise. The "What does Orbit do?" panel is what offers the button to
  // enable it — here the row simply does not appear.
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
   * The opening list freezes at the instant it starts to leave.
   *
   * Entering a session swaps the active session in the same tick in which the center
   * starts the exit fade — and that session's "Resume" would stop existing
   * right there. The card disappeared with the screen still visible, and the pills reflowed
   * in front of whoever had just clicked. While the opening is standing, the
   * content does not change; it is only recalculated when the screen returns to rest.
   */
  const [welcomeSuggestions, setWelcomeSuggestions] = useState(startSuggestions)
  useEffect(() => {
    if (!hasChat) setWelcomeSuggestions(startSuggestions)
  }, [hasChat, startSuggestions])

  /**
   * The grid has two columns. A pill that takes the whole row ("Resume")
   * already closes the row by itself and therefore does NOT enter the parity: counting
   * it, "Resume" + two capabilities came out odd and the last capability fell
   * alone into the row below, centered. The remainder is counted only among the
   * half-width pills; when it is odd, the last one centers.
   */
  const halfWidthCount = welcomeSuggestions.filter(suggestion => suggestion.action.kind !== "open").length
  const oddLeftover =
    halfWidthCount % 2 === 1 && welcomeSuggestions[welcomeSuggestions.length - 1]?.action.kind !== "open"

  const handleStartSuggestion = useCallback(
    (suggestion: StartSuggestion) => {
      if (suggestion.action.kind === "fill") {
        // It fills, it does not send: the person is who presses Enter.
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
      // localStorage unavailable cannot prevent the panel from opening
    }
  }, [])

  const handleCapabilityPick = useCallback(
    (example: string) => {
      useDraftInput.getState().setDraft(session?.id ?? null, example)
      setCapabilitiesOpen(false)
    },
    [session?.id],
  )

  // Each line of the opening enters on its own, after the persona: title →
  // subtitle → button. The delay lives in the transition-delay because the transition
  // already runs in CSS; when leaving the screen the delays go back to zero and everything disappears together.
  // 1s per line and a curve that decelerates slowly (not the short `ease-out`)
  // is what makes the entrance seem slow instead of rushed.
  const introLine = `transition-all duration-1000 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
    introVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1.5"
  }`

  // ── Conversational cards, inside the flow ─────────────────────────────
  // Agent request, revert, plan and progress only exist WHEN there is
  // a conversation, so they live in it: they enter as the last item of the list and scroll
  // along. Before, they took the fixed strip above the input, and each card that
  // appeared shortened the history — with two or three, the conversation collapsed.
  // Only the ones that also exist WITHOUT a conversation stay out (project init,
  // vision and provider notices): those need to appear on the start screen,
  // where there is no list to enter, and they stay in the strip.
  const planInFlow = !!plan && (plan.status === "proposed" || plan.status === "approved" || plan.status === "running" || plan.status === "done")
  // The offer to continue in a new chat is only valid for the summary count of the
  // moment it was made: a new compaction (which changes the count) hides
  // the card without needing any manual invalidation.
  const summaryCount = useMemo(
    () => messages.reduce((total, m) => (m.summary ? total + 1 : total), 0),
    [messages],
  )
  const showCompactionSuggestion =
    !!compactionSuggestion &&
    !compactionSuggestion.dismissed &&
    compactionSuggestion.summaries === summaryCount

  const hasInlineCards =
    !!session?.revert || planInFlow || pendingAsks.length > 0 || showCompactionSuggestion

  // -mt-4 eats half of ConversationContent's gap-8: the card stays near
  // the turn that generated it, without sticking to the last message.
  const inlineCards = (
    <div className="mx-auto -mt-4 flex w-full max-w-2xl flex-col gap-2 px-1 pb-1">
      {/* Revert active: bar with undone changes + undo button */}
      {session?.revert && <RevertBar session={session} />}
      {/* Proposed orchestration plan — approve/reject */}
      {session && plan && plan.status === "proposed" && (
        <OrchestrationPlanCard sessionId={session.id} plan={plan} />
      )}
      {/* Plan running/finished — task progress. The mode is fixed:
          an orchestration worker always runs in the working folder. */}
      {session && plan && (plan.status === "approved" || plan.status === "running" || plan.status === "done") && (
        <TaskProgress
          tasks={plan.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            mode: "code" as const,
            phase: t.phase,
            extra: t.extra,
            revisions: t.revisions,
            note: t.reviewNote,
            sessionId: t.workerSessionId,
            agent: t.agent,
            waitsFor: (t.dependsOn ?? [])
              .map((id) => plan.tasks.find((x) => x.id === id))
              .filter((x): x is NonNullable<typeof x> => !!x && x.phase !== "accepted")
              .map((x) => x.title),
          }))}
          followUp={plan.review}
          onMergeAgain={() => chatApi.mergeOrchestration(session.id)}
          title={t("chat.orchestrationTitle")}
          // "Running" is a fact of the main process, not of the stored phases: a
          // plan whose run died with the app keeps `running` in the file, and
          // reading that as "in progress" is what left the card spinning — with no
          // X, since it only appeared once nothing was running.
          live={plan.status === "approved" || plan.status === "running"}
          interrupted={plan.interrupted}
          onContinue={() => useSessionStore.getState().resumeOrchestration(session.id)}
          // Collapsed: the summary ("5 workers · 3 running") is the point; a failure shows in it.
          defaultExpanded={false}
          onDismiss={() => useSessionStore.getState().dismissOrchestration(session.id)}
        />
      )}
      {/* Context near the limit after accumulated compactions: offers
          continuing in a new chat (with a brief from the agent) instead of summarizing a
          summary. It is an offer, not a block — ignored, the automatic compaction
          of the next turn runs as always. */}
      {session && showCompactionSuggestion && compactionSuggestion && (
        <CompactionSuggestionCard
          sessionId={session.id}
          summaries={compactionSuggestion.summaries}
        />
      )}
      {/* Requests waiting for an answer (permission / question): the card is the last
          thing in the conversation — it is where the turn stopped waiting. Items with batchId
          (batched workers) group into a single card with a single submit. The ref is
          what decides whether the pending chip needs to appear. */}
      {pendingAsks.length > 0 && (
        <div ref={pendingAsksRef} className="flex flex-col gap-2">
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
    </div>
  )

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
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
          <div
            className={
              startScreen
                ? "flex w-full flex-col items-center pt-24"
                : "flex flex-col items-center gap-4 pt-40"
            }
          >
            {startScreen ?? (
              <>
            {personaOnWelcome && (
              <div
                className="flex justify-center transition-all ease-in-out"
                style={{
                  width: "8rem",
                  height: "8rem",
                  opacity: centerPersonaVisible ? 1 : 0,
                  // It appears all at once when coming back to the new chat screen (as
                  // the top appears on entering the chat) and leaves with a fade on entering.
                  transitionDuration: centerPersonaVisible ? "0ms" : "500ms",
                }}
              >
                <Persona state={centerPersonaState} className="!size-full" />
              </div>
            )}
            {/* Without the persona above, the text block goes down the space it
                would take (8rem) plus the container gap (1rem): the title stays
                at the same height in both states instead of sticking to the top. */}
            <div className={`flex flex-col items-center gap-6 ${personaOnWelcome ? "" : "pt-36"}`}>
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
                    {/* Thin line that is born at the edge of the button and opens
                        outwards, slowly: it draws the eye to the only real block
                        of the app without making the button blink. Whoever asked the system for less motion
                        does not see the pulsation. */}
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
                /* The suggestions enter after the subtitle, in the same step: without
                    this they appeared fixed while the persona was still
                    sleeping, and the screen got the buttons before any
                    text. */
                <div
                  className={`flex w-full max-w-md flex-col items-center gap-1 ${introLine}`}
                  style={{ transitionDelay: introVisible ? `${INTRO_STEP_MS * 2}ms` : "0ms" }}
                >
                  {welcomeSuggestions.length > 0 && (
                    <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                      {welcomeSuggestions.map((suggestion, index) => (
                        <Suggestion
                          key={suggestion.id}
                          suggestion={suggestion.label}
                          onClick={() => handleStartSuggestion(suggestion)}
                          className={cn(
                            "h-auto justify-start gap-2 py-1.5 text-left leading-snug whitespace-normal",
                            suggestion.action.kind === "open" && "sm:col-span-2",
                            /* With no session to resume only capabilities remain, and
                               three pills leave one alone on the second row:
                               it looks like the fourth is missing. The remainder takes the row
                               and centers itself, so any count closes. */
                            oddLeftover && index === welcomeSuggestions.length - 1 &&
                              "sm:col-span-2 sm:justify-self-center",
                          )}
                          title={suggestion.action.kind === "fill" ? suggestion.action.text : undefined}
                        >
                          {suggestion.action.kind === "open" ? (
                            <History className="size-3.5 shrink-0" />
                          ) : suggestion.capability ? (
                            <CapabilityIcon capability={suggestion.capability} className="size-3.5 shrink-0" />
                          ) : null}
                          <span className="min-w-0 flex-1">{suggestion.label}</span>
                          {/* A capability of a family the person has not yet
                              produced — the invitation is to try it, not a
                              novelty badge. */}
                          {suggestion.fresh && (
                            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
                          )}
                        </Suggestion>
                      ))}
                    </div>
                  )}
                  {/* Meta-navigation, not a fourth suggestion: the capability
                      map is small on purpose and does not compete with the
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
              </>
            )}
          </div>
        </div>

        <div
          className={`absolute inset-0 flex flex-col transition-all duration-500 ease-in-out ${
            chatVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className={`flex min-h-0 flex-1 flex-col ${showTopPersona ? "pt-6" : "pt-2"}`}>
            {/* Veil that dissolves the conversation under the floating persona. It
                exists BECAUSE of it: without the persona at the top there is nothing to
                hide, and the strip becomes just three centimeters of nothing eating the
                start of the list. Same condition as the breathing room above. */}
            {showTopPersona && (
              <div className="pointer-events-none sticky top-0 z-10 h-12 bg-linear-to-b to-transparent" style={{ backgroundImage: 'linear-gradient(to bottom, var(--panel-bg, var(--background)), transparent)' }} />
            )}
            {/* It applies in both modes: the code conversation also has a history
                to search, and the header menu now offers it there. */}
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
              footer={hasInlineCards ? inlineCards : null}
              underVeil={showTopPersona}
              dateVariant={dateSeparator}
            />
          </div>
        </div>
      </div>
      {/* New project in code mode: the card offers the automatic /init. It stays in the
          strip, and not in the conversation, because it exists precisely when there is not
          any conversation yet (the list is empty/hidden). */}
      {viewMode === "code" && initDirectory && !hideInitCard && (
        <div className="mx-auto w-full max-w-2xl pb-2">
          <InitProjectCard directory={initDirectory} sessionId={session?.id} />
        </div>
      )}
      {/* Image attached with a model without vision and Vision mode off. It can
          also exist without a conversation (pending image on the start screen). */}
      <VisionHintCard sessionId={session?.id} />
      {/* Send attempt with no provider configured (first run) */}
      <ProviderHintCard visible={providerHintVisible} onDismiss={() => setProviderHintVisible(false)} />
      {/* Pending item out of sight: the request card is in the conversation, and this
          shortcut leads to it. It only exists when the card left the visible area. */}
      {hasPendingAsks && !pendingAskVisible && (
        <div className="mx-auto flex w-full max-w-2xl px-1 pb-1">
          <button
            type="button"
            onClick={revealPendingAsk}
            className="group inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
          >
            <HelpCircle className="size-3.5 shrink-0" />
            {t("chat.pendingAsk", { count: pendingAsks.length })}
            <ArrowDown className="size-3.5 shrink-0 opacity-70 transition-transform group-hover:translate-y-0.5" />
          </button>
        </div>
      )}
      <ComputerThumbCard sessionId={session?.id} />
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
          folders={chatFolders}
          onFoldersChange={handleFoldersChange}
          showFolders={!hideFolders}
        />
      )}
    </div>
  )
}

