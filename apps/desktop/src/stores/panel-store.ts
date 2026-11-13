import { create } from "zustand"
import type { PanelSnapshot, PanelSnapshotTab } from "@shared/panel"

export type TabType = "chat" | "terminal" | "process" | "folders" | "browser" | "diff" | "media" | "artifact" | "sources" | "source" | "document" | "motion" | "design" | "slides" | "memory" | "routine" | "fragment"

export interface PanelTab {
  id: string
  type: TabType
  title: string
  sessionId?: string
  messageId?: string
  /** Diff tab of a pipeline task (instead of a chat message) */
  pipelineId?: string
  taskId?: string
  pending?: boolean
  /** Initial URL of the Browser tab (absent = opens the default screen with search). */
  url?: string
  /** Process tab: PID of the background process whose output the tab follows. */
  processPid?: number
  /** Artifact tab: registry id (art_xxx.html) the tab renders. */
  artifactId?: string
  /** Fragment tab: id (frag-…) of the fragment it renders. Absent = the picker of existing fragments. */
  fragmentId?: string
  /** Fragment tab: the screen of the fragment to open first (a widget's destination). */
  fragmentRoute?: string
  /** Document tab: registry id (doc_xxx.md) opened in the Markdown canvas. */
  documentId?: string
  /** Motion tab: registry id (mv_xxx) of the composition the tab renders. */
  motionId?: string
  /** Path of the composition entry INSIDE the registered folder — it is what the
   *  URL `orbit-motion://<id>/<relative-path>` serves. */
  motionEntry?: string
  /** ABSOLUTE path of the entry — what the motion note hands to the agent
   *  (the entry alone, "index.html", does not say which composition is meant). */
  motionPath?: string
  /** Slides tab: registry id (sld_xxx) of the deck the tab presents. */
  slidesId?: string
  /** Path of the deck entry INSIDE the registered folder — it is what the URL
   *  `orbit-slides://<id>/<relative-path>` serves. */
  slidesEntry?: string
  /** ABSOLUTE path of the entry — what the slides note hands to the agent. */
  slidesPath?: string
  /** Design tab: registry id (dsg_xxx) of the canvas the tab renders. */
  designId?: string
  /** ABSOLUTE path of the canvas folder — what the design note hands to the agent. */
  designPath?: string
  /** Design tab in PRESENTATION mode: the artboard where the prototype starts. The
   *  tab shows one screen at a time and navigates through the links — it is not the editing one. */
  designPlay?: string
  /** The presentation was opened from the editor in full screen: it is born in full screen. */
  designFullscreen?: boolean
  /** Memory tab: registry id (mem_xxx) opened by a citation in the conversation. */
  memoryId?: string
  /** Routine tab: the routine opened from the Routines page. */
  routineId?: string
  /** Source tab: document opened by a citation, and the stretch to highlight. */
  sourceDocId?: string
  sourcePage?: number
  sourceFromLine?: number
  sourceToLine?: number
}

export interface BrowserSelection {
  id: string
  tag: string
  selector: string
  text: string
  html: string
  url: string
  /** Where the element was picked, in words, when it is not the panel browser ("the fragment …"). */
  where?: string
}

/**
 * Stretch cited from the document viewer, waiting to be sent.
 *
 * It lives in the same place as the panel browser selections because it is the same
 * gesture: something selected in a panel that becomes an attachment of the next message. The
 * composer reads from here at send time.
 */
export interface DocumentQuote {
  id: string
  /** Agent document or conversation source — see DocumentQuotePayload. */
  kind: "document" | "source"
  docId: string
  /** Displayable name of the document — it is what appears in the chip. */
  name: string
  page?: number
  fromLine?: number
  toLine?: number
  text: string
}

/**
 * Instant pointed at in the Motion tab, waiting to be sent.
 *
 * Same place and same gesture as the cited stretches — pointing at something in a panel and
 * attaching it to the next message — but what is pointed at is an INSTANT, not a stretch
 * of text: that is why the fields are different (composition, frame, fps). The frame is
 * the truth; the seconds are derived for display (see MotionQuotePayload).
 */
export interface MotionQuote {
  id: string
  kind: "motion"
  /** Path of the entry INSIDE the registered folder (see PanelTab.motionEntry). */
  file: string
  /** Displayable name of the composition. */
  name: string
  /** Whole frame of the playhead at the moment of the click. */
  frame: number
  fps: number
  /** Absolute path of the entry (see PanelTab.motionPath). */
  path?: string
  /** Layer selected in the layer strip, when there is one. */
  layer?: string
  /** Sound track selected, when the focus is a sound and not a DOM element
   *  (the piece audio lives outside the stage — see motion-audio.ts). */
  audio?: string
  /** Layers on stage at that frame. */
  onScreen?: string[]
}

/**
 * Element pointed at in the Design tab, waiting to be sent. Same gesture as the
 * motion instant — pointing at something in a panel and attaching it to the next message —,
 * but here several ACCUMULATE ("these two buttons"); the same element twice
 * does not (see DesignQuotePayload).
 */
export interface DesignQuote {
  id: string
  kind: "design"
  name: string
  path?: string
  file: string
  boardTitle?: string
  elementPath?: number[]
  tag?: string
  label?: string
  text?: string
  html?: string
}

/**
 * Widget pointed at in the Widgets tab, waiting to be sent. Same gesture as the design element
 * — pointing at something in a panel and attaching it to the next message —, but what it
 * addresses is the widget inside the fragment. The SAME widget asked twice stays once
 * (see addQuote).
 */
export interface WidgetQuote {
  id: string
  kind: "widget"
  fragmentId: string
  fragmentName?: string
  widgetId: string
  name: string
  size: string
  sizes?: string[]
}

/** What a citation attachment can be — see QuotePayload. */
export type PanelQuote = DocumentQuote | MotionQuote | DesignQuote | WidgetQuote

export interface Viewport {
  width: number
  height: number
  label: string
}

export interface ActivityEntry {
  id: string
  label: string
  at: number
}

export type PanelEvent =
  | { type: "ensure"; url?: string; sessionId: string }
  | { type: "resize"; width: number | null; height: number | null; label: string }
  | { type: "fullscreen"; on: boolean }
  | { type: "activity"; label: string; sessionId?: string }
  /**
   * The tool registered a motion composition and wants the preview in the panel.
   * `id` is main's registry (mv_xxx), `entry` the entry inside the folder the
   * scheme serves and `title` the displayable name. `sessionId` is optional: the event's
   * contract is only `{id, entry, title}`, and without it the tab falls into the active chat's
   * bucket (resolved in the App) or into the orphan one.
   */
  | { type: "motion"; id: string; entry: string; title: string; sessionId?: string; path?: string }
  /**
   * The tool registered a design canvas and wants the preview in the panel. `id` is
   * main's registry (dsg_xxx) and `title` the displayable name — unlike motion
   * there is no `entry`: the tab reads `canvas.json` and draws all the artboards.
   */
  | { type: "design"; id: string; title: string; sessionId?: string; path?: string }
  /**
   * The tool registered a slides deck and wants the stage in the panel. `id` is
   * main's registry (sld_xxx), `entry` the file inside the folder the scheme
   * serves and `title` the displayable name. `sessionId` is optional: without it the tab falls
   * into the active chat's bucket (resolved in the App).
   */
  | { type: "slides"; id: string; entry: string; title: string; sessionId?: string; path?: string }
  /**
   * The agent created or rewrote a fragment and wants it on screen. `id` is the
   * fragment's id (frag-…); the tab mounts orbit-fragment://<id>/ and reloads on its own
   * when the fragment changes.
   */
  | { type: "fragment"; id: string; title: string; sessionId?: string }
  /**
   * Pieces that no longer exist (deleted by the agent or undone by a
   * revert): their tabs close in every chat.
   */
  | { type: "pieces-removed"; motion: string[]; design: string[]; slides: string[] }

/** Agent browser registry per chat/task session. */
export interface AgentBrowserEntry {
  /** Last URL the agent opened/is viewing. */
  url: string
  /** Last instant the agent touched the browser (keeps the indicator fresh). */
  at: number
}

/** "Recently used" window of the agent browser indicator (ms). */
export const AGENT_BROWSER_FRESH_MS = 30_000

interface PanelState {
  /**
   * Panel OPEN by tab bucket. The agent works in the background, in a chat that
   * is not the one on the screen: its tab is born in ITS bucket, and the panel opens
   * there — the user's chat is not touched. The one on the screen is the App, which shows
   * `openBySession[active session's bucket]`.
   */
  openBySession: Record<string, boolean>
  /** Bucket the screen is showing. It gives an owner to an opening requested by
   *  something that is not a session (pipeline task diff, tab picked in "+"). */
  uiBucket: string
  setUiBucket: (bucket: string) => void
  setRightPanelOpen: (open: boolean) => void

  /** SelectorScreen opened by the "+" even with an active tab — the panel's start
   *  screen, where the tab grid and the background processes are. */
  selectorOpen: boolean
  setSelectorOpen: (open: boolean) => void
  /** Opens (or reuses) the tab that follows the output of a background
   *  process. `sessionId` is the key of the tab bucket (active chat or orphan). */
  openProcessTab: (sessionId: string, pid: number, title: string, ownerSessionId?: string) => void

  /** Tabs per chat session */
  tabsBySession: Record<string, PanelTab[]>
  activeTabBySession: Record<string, string | null>
  addTab: (sessionId: string, tab: PanelTab) => void
  removeTab: (sessionId: string, tabId: string) => void
  /** Closes the tabs of the motion compositions that were deleted (in any conversation). */
  closeMotionTabs: (motionIds: string[]) => void
  /** Closes the tabs of the design canvases that were deleted (in any conversation). */
  closeDesignTabs: (designIds: string[]) => void
  /** Closes the tabs of the decks that were deleted (see closeDesignTabs). */
  closeSlidesTabs: (slidesIds: string[]) => void
  /** Closes the tabs of the artifacts that were deleted (in any conversation). */
  closeArtifactTabs: (artifactIds: string[]) => void
  /** Closes the tabs of the fragments that were deleted (in any conversation). */
  closeFragmentTabs: (fragmentIds: string[]) => void
  /** Opens (or focuses) a fragment. An empty picker tab of the conversation is reused. */
  openFragmentTab: (ref: { id: string; title: string; sessionId?: string; route?: string }) => void
  setActiveTab: (sessionId: string, tabId: string | null) => void
  setTabsForSession: (sessionId: string, tabs: PanelTab[], activeId: string | null) => void
  /** Opens (or reuses) the tab that renders an artifact in full screen.
   *  Called by the card in the conversation and by the gallery. */
  openArtifactTab: (sessionId: string, artifactId: string, title: string) => void
  /** Opens (or reuses) the preview of a motion composition. Called by main's
   *  `motion` event (the tool registered the folder) — never by the selector.
   *  Reopening the SAME composition focuses the tab wherever it is. */
  openMotionTab: (ref: { id: string; entry: string; title: string; sessionId?: string; path?: string }) => void
  /** Opens (or reuses) the preview of a design canvas. Called by main's
   *  `design` event (the tool registered the folder) — never by the selector.
   *  Reopening the SAME canvas focuses the tab wherever it is. Mirrors openMotionTab. */
  openDesignTab: (ref: { id: string; title: string; sessionId?: string; path?: string }) => void
  /** Opens (or reuses) the stage of a slides deck. Called by main's
   *  `slides` event (the tool registered the folder) — never by the selector. Reopening
   *  the SAME deck focuses the tab wherever it is. Mirrors openDesignTab. */
  openSlidesTab: (ref: { id: string; entry: string; title: string; sessionId?: string; path?: string }) => void
  /** Opens (or reuses) the tab that PRESENTS a canvas navigating between the
   *  screens, starting at `file`. Born from the artboard's Play button; `fullscreen`
   *  takes the editor state so the presentation opens in the same mode. */
  openDesignPlayTab: (designId: string, file: string, fullscreen?: boolean) => void
  /** Opens (or reuses) the Markdown canvas of a live document — the one
   *  ASKED for as PDF/Word opens in the viewer, through openSourceTab. */
  openDocumentTab: (sessionId: string, ref: { documentId: string; title: string }) => void
  /** Opens (or reuses) the tab that shows a source at the cited stretch.
   *  Called by the citation in the conversation. */
  openSourceTab: (
    sessionId: string,
    ref: { docId: string; page: number; fromLine?: number; toLine?: number; title: string },
  ) => void
  /** Opens (or reuses) the tab with a memory cited in the conversation. Same
   *  idea as openSourceTab: one tab per memory, reopening focuses the existing one. */
  openMemoryTab: (sessionId: string, ref: { memoryId: string; title: string }) => void
  /** Opens (or reuses) the tab with a routine from the Routines page: one tab per routine,
   *  clicking it again focuses the existing one. */
  openRoutineTab: (sessionId: string, ref: { routineId: string; title: string }) => void
  /** New chat became a session: the tabs opened in the orphan bucket now belong to it. */
  adoptOrphanTabs: (sessionId: string) => void
  getTabs: (sessionId: string) => PanelTab[]
  getActiveTabId: (sessionId: string) => string | null
  /** Updates the title of the chat tabs that point to a session (e.g.: the agent named the chat). */
  renameChatTabs: (sessionId: string, title: string) => void
  /** Current URL of a browser tab — called by the pool on every navigation,
   *  including with the tab unmounted (agent navigating in the background). It is what
   *  makes the tab come back on the same page when leaving and re-entering the chat. */
  setTabUrl: (sessionId: string, tabId: string, url: string) => void

  /** Agent browser per session (chat/task): current URL + last use. Feeds
   *  the "testing…" indicator in the header and in the conversation. The entry only leaves when
   *  the session is ended; freshness is measured by `at` + AGENT_BROWSER_FRESH_MS. */
  agentBrowser: Record<string, AgentBrowserEntry>
  /** Ensures the agent's Browser tab in the session (creates/updates), without opening the panel. */
  ensureAgentBrowserTab: (sessionId: string, url?: string) => void
  /** Opens the side panel with the session's agent browser (user click). */
  openAgentBrowser: (sessionId: string) => void
  /** Link clicked in the terminal: opens a NEW browser tab with the URL, in the terminal's session. */
  openTerminalLink: (sessionId: string, url: string) => void
  selectMode: boolean
  setSelectMode: (value: boolean) => void
  selections: BrowserSelection[]
  addSelection: (selection: Omit<BrowserSelection, "id">) => void
  removeSelection: (id: string) => void
  clearSelections: () => void
  quotes: PanelQuote[]
  /** Attaches a cited stretch or a motion instant. The instant REPLACES the
   *  previous one instead of accumulating: two frames of the same composition do not form a
   *  single request — the user wants "this point", not "these points". */
  addQuote: (
    quote: Omit<DocumentQuote, "id"> | Omit<MotionQuote, "id"> | Omit<DesignQuote, "id"> | Omit<WidgetQuote, "id">,
  ) => void
  removeQuote: (id: string) => void
  clearQuotes: () => void
  viewport: Viewport | null
  setViewport: (viewport: Viewport | null) => void
  fullscreen: boolean
  setFullscreen: (value: boolean) => void
  agentActive: boolean
  activity: ActivityEntry[]
  pushActivity: (label: string) => void
  applyEvent: (event: PanelEvent) => void

  openChatTab: (sessionId: string, title: string) => void
  pendingChatTab: number
  pendingChatTabSession?: string
  pendingChatTabTitle?: string

  openChatTabWithPendingInput: (sessionId: string, title: string, input: string) => void
  pendingInput: { sessionId: string; text: string } | null
  setPendingInput: (val: { sessionId: string; text: string } | null) => void

  openDiff: (sessionId: string, messageId: string, title: string) => void
  /** Diff of a pipeline task — same panel, another source of the patch */
  openTaskDiff: (pipelineId: string, taskId: string, title: string) => void
  pendingDiff: number
  pendingDiffSessionId?: string
  pendingDiffMessageId?: string
  pendingDiffPipelineId?: string
  pendingDiffTaskId?: string
  pendingDiffTitle?: string
}

/** Bucket of the tabs of a chat that has not become a session yet (see adoptOrphanTabs). */
/**
 * The Fragments page, while it is on screen, takes over the "fragment" events of the
 * fragment it is showing (or the one being created from it) — so the same fragment is
 * not ALSO opened as a side-panel tab. Registered by the page; absent otherwise.
 */
type FragmentClaimer = (event: { id: string; sessionId?: string }) => boolean
let fragmentClaimer: FragmentClaimer | null = null
export function setFragmentClaimer(claimer: FragmentClaimer | null): void {
  fragmentClaimer = claimer
}

export const ORPHAN_KEY = "__orphan__"

/**
 * Session stamped on the tab. In the orphan bucket there is no session yet: the tab is left
 * without an owner, and adoptOrphanTabs stamps the one that is born — writing "__orphan__" on it
 * would tie it to an id that does not exist.
 */
function tabSession(sessionId: string): string | undefined {
  return sessionId === ORPHAN_KEY ? undefined : sessionId
}

/**
 * Marks the bucket's panel as OPEN. Whether it appears NOW is not decided
 * here: a tab may be born for a chat the agent is working on in the
 * background, and opening the panel of the chat the user is seeing would open the wrong
 * panel — whoever looks at the screen's bucket is the App.
 *
 * The tab selector (the "+") is also the SCREEN's: a tab opened for another chat
 * cannot close what the user is seeing there.
 */
function openPanel(
  state: PanelState,
  bucket: string,
): Pick<PanelState, "openBySession" | "selectorOpen"> {
  return {
    openBySession: { ...state.openBySession, [bucket]: true },
    selectorOpen: bucket === state.uiBucket ? false : state.selectorOpen,
  }
}

let activeTimer: ReturnType<typeof setTimeout> | null = null
const ACTIVE_TIMEOUT_MS = 6000

let _nextTabId = 0
export function nextTabId(): number {
  return ++_nextTabId
}

export const usePanelStore = create<PanelState>((set, get) => {
  const markActive = () => {
    if (activeTimer) clearTimeout(activeTimer)
    activeTimer = setTimeout(() => set({ agentActive: false }), ACTIVE_TIMEOUT_MS)
    set({ agentActive: true })
  }

  return {
    openBySession: {},
    uiBucket: ORPHAN_KEY,
    setUiBucket: (bucket) => set({ uiBucket: bucket }),
    setRightPanelOpen: (open) =>
      set((state) => ({ openBySession: { ...state.openBySession, [state.uiBucket]: open } })),

    selectorOpen: false,
    setSelectorOpen: (open) => set({ selectorOpen: open }),

    // One tab per process: clicking the same card again focuses the tab that already
    // follows the output instead of stacking two views of the same stdout.
    openProcessTab: (sessionId, pid, title, ownerSessionId) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        const existing = tabs.find((t) => t.type === "process" && t.processPid === pid)
        const id = existing?.id ?? `process-${nextTabId()}`
        const nextTabs = existing
          ? tabs
          : [
              {
                id,
                type: "process" as const,
                title,
                processPid: pid,
                // Owner of the process: in "all chats" mode a line opens the
                // output of a process from ANOTHER chat, and main only returns output
                // to the owner (getProcessOutput). The tab stays in the current bucket.
                sessionId: ownerSessionId,
              },
            ]
        return {
          ...openPanel(state, sessionId),
          tabsBySession: { ...state.tabsBySession, [sessionId]: nextTabs },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: id },
        }
      }),

    tabsBySession: {},
    activeTabBySession: {},

    addTab: (sessionId, tab) =>
      set((state) => ({
        tabsBySession: {
          ...state.tabsBySession,
          [sessionId]: [...(state.tabsBySession[sessionId] ?? []), tab],
        },
      })),

    closeMotionTabs: (motionIds) =>
      set((state) => {
        if (motionIds.length === 0) return state
        const gone = new Set(motionIds)
        const tabsBySession: typeof state.tabsBySession = {}
        const activeTabBySession = { ...state.activeTabBySession }
        for (const [key, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.filter((t) => !(t.type === "motion" && t.motionId && gone.has(t.motionId)))
          tabsBySession[key] = next
          if (next.length !== tabs.length && !next.some((t) => t.id === activeTabBySession[key])) {
            activeTabBySession[key] = next.length > 0 ? next[0].id : null
          }
        }
        return { tabsBySession, activeTabBySession }
      }),

    closeDesignTabs: (designIds) =>
      set((state) => {
        if (designIds.length === 0) return state
        const gone = new Set(designIds)
        const tabsBySession: typeof state.tabsBySession = {}
        const activeTabBySession = { ...state.activeTabBySession }
        for (const [key, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.filter((t) => !(t.type === "design" && t.designId && gone.has(t.designId)))
          tabsBySession[key] = next
          if (next.length !== tabs.length && !next.some((t) => t.id === activeTabBySession[key])) {
            activeTabBySession[key] = next.length > 0 ? next[0].id : null
          }
        }
        return { tabsBySession, activeTabBySession }
      }),

    closeSlidesTabs: (slidesIds) =>
      set((state) => {
        if (slidesIds.length === 0) return state
        const gone = new Set(slidesIds)
        const tabsBySession: typeof state.tabsBySession = {}
        const activeTabBySession = { ...state.activeTabBySession }
        for (const [key, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.filter((t) => !(t.type === "slides" && t.slidesId && gone.has(t.slidesId)))
          tabsBySession[key] = next
          if (next.length !== tabs.length && !next.some((t) => t.id === activeTabBySession[key])) {
            activeTabBySession[key] = next.length > 0 ? next[0].id : null
          }
        }
        return { tabsBySession, activeTabBySession }
      }),

    closeArtifactTabs: (artifactIds) =>
      set((state) => {
        if (artifactIds.length === 0) return state
        const gone = new Set(artifactIds)
        const tabsBySession: typeof state.tabsBySession = {}
        const activeTabBySession = { ...state.activeTabBySession }
        for (const [key, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.filter((t) => !(t.type === "artifact" && t.artifactId && gone.has(t.artifactId)))
          tabsBySession[key] = next
          if (next.length !== tabs.length && !next.some((t) => t.id === activeTabBySession[key])) {
            activeTabBySession[key] = next.length > 0 ? next[0].id : null
          }
        }
        return { tabsBySession, activeTabBySession }
      }),

    closeFragmentTabs: (fragmentIds) =>
      set((state) => {
        if (fragmentIds.length === 0) return state
        const gone = new Set(fragmentIds)
        const tabsBySession: typeof state.tabsBySession = {}
        const activeTabBySession = { ...state.activeTabBySession }
        for (const [key, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.filter((t) => !(t.type === "fragment" && t.fragmentId && gone.has(t.fragmentId)))
          tabsBySession[key] = next
          if (next.length !== tabs.length && !next.some((t) => t.id === activeTabBySession[key])) {
            activeTabBySession[key] = next.length > 0 ? next[0].id : null
          }
        }
        return { tabsBySession, activeTabBySession }
      }),

    // A fragment is a resource of the app, not of a message: ONE tab per fragment in
    // each conversation (reopening focuses it). A picker tab left empty in this
    // conversation (the "+" selector) is filled instead of stacking a second tab.
    openFragmentTab: (ref) =>
      set((state) => {
        const bucket = ref.sessionId ?? state.uiBucket
        const tabs = state.tabsBySession[bucket] ?? []
        const existing = tabs.find((t) => t.type === "fragment" && t.fragmentId === ref.id)
        const picker = tabs.find((t) => t.type === "fragment" && !t.fragmentId)
        const tab: PanelTab = existing
          ? { ...existing, title: ref.title, fragmentRoute: ref.route }
          : picker
            ? { ...picker, fragmentId: ref.id, title: ref.title, fragmentRoute: ref.route }
            : {
                id: `fragment-${nextTabId()}`,
                type: "fragment",
                title: ref.title,
                sessionId: tabSession(bucket),
                fragmentId: ref.id,
                fragmentRoute: ref.route,
              }
        const base = existing ?? picker
        return {
          ...openPanel(state, bucket),
          tabsBySession: {
            ...state.tabsBySession,
            [bucket]: base ? tabs.map((t) => (t === base ? tab : t)) : [...tabs, tab],
          },
          activeTabBySession: { ...state.activeTabBySession, [bucket]: tab.id },
        }
      }),

    removeTab: (sessionId, tabId) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId]
        if (!tabs) return state
        const next = tabs.filter((t) => t.id !== tabId)
        const activeId = state.activeTabBySession[sessionId]
        let nextActive = state.activeTabBySession
        if (activeId === tabId || next.length === 0) {
          const newActive = next.length > 0 ? next[Math.min(0, next.length - 1)].id : null
          nextActive = { ...state.activeTabBySession, [sessionId]: newActive }
        }
        return {
          tabsBySession: { ...state.tabsBySession, [sessionId]: next },
          activeTabBySession: nextActive,
        }
      }),

    setActiveTab: (sessionId, tabId) =>
      set((state) => ({
        activeTabBySession: { ...state.activeTabBySession, [sessionId]: tabId },
      })),

    setTabsForSession: (sessionId, tabs, activeId) =>
      set((state) => ({
        tabsBySession: { ...state.tabsBySession, [sessionId]: tabs },
        activeTabBySession: { ...state.activeTabBySession, [sessionId]: activeId },
      })),

    // Opening a tab from the CONVERSATION (artifact/document card, source
    // citation) points the panel at it — so the tab selector leaves the
    // scene, as the process card and the terminal link already do. Without this,
    // whoever had the selection screen open (the "+") clicked "Open in
    // panel" and nothing happened: the tab was born hidden behind the selector.
    openArtifactTab: (sessionId, artifactId, title) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        // Reopening the same artifact focuses the existing tab instead of stacking
        // copies — the artifact is one, so is the tab.
        const existing = tabs.find((t) => t.type === "artifact" && t.artifactId === artifactId)
        if (existing) {
          return {
            ...openPanel(state, sessionId),
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `artifact-${nextTabId()}`,
          type: "artifact",
          title,
          sessionId: tabSession(sessionId),
          artifactId,
        }
        return {
          ...openPanel(state, sessionId),
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    // The motion composition is a PROJECT resource, not a message one: the
    // tab is born from main's event that registered the folder. In the SAME conversation the
    // piece is ONE tab — two would be two iframes and two playheads of the same
    // thing. In ANOTHER conversation it can have its own tab too: the agent may
    // be working on one chat's composition while the user looks at another, and
    // taking the tab from there would be touching what the user has on the screen.
    openMotionTab: (ref) =>
      set((state) => {
        const bucket = ref.sessionId ?? ORPHAN_KEY
        const tabs = state.tabsBySession[bucket] ?? []
        // The same composition by id OR by file: an old tab (from before
        // the stable id) is reused and starts pointing to the new id.
        const existing = tabs.find(
          (t) => t.type === "motion" && (t.motionId === ref.id || (ref.path != null && t.motionPath === ref.path)),
        )
        const tab: PanelTab = existing
          ? { ...existing, motionId: ref.id, motionEntry: ref.entry, motionPath: ref.path ?? existing.motionPath }
          : {
              id: `motion-${nextTabId()}`,
              type: "motion",
              title: ref.title,
              sessionId: tabSession(bucket),
              motionId: ref.id,
              motionEntry: ref.entry,
              motionPath: ref.path,
            }
        return {
          ...openPanel(state, bucket),
          tabsBySession: {
            ...state.tabsBySession,
            [bucket]: existing ? tabs.map((t) => (t === existing ? tab : t)) : [...tabs, tab],
          },
          activeTabBySession: { ...state.activeTabBySession, [bucket]: tab.id },
        }
      }),

    // Same reasoning as openMotionTab: the canvas is a PROJECT resource
    // (conversation, in chat mode), not a message one — the tab is born from main's event
    // that registered the folder. One per conversation, not one in the world: the other
    // chat's stays where it is.
    openDesignTab: (ref) =>
      set((state) => {
        const bucket = ref.sessionId ?? ORPHAN_KEY
        const tabs = state.tabsBySession[bucket] ?? []
        const existing = tabs.find((t) => t.type === "design" && !t.designPlay && t.designId === ref.id)
        const tab: PanelTab = existing
          ? { ...existing, designPath: ref.path ?? existing.designPath }
          : {
              id: `design-${nextTabId()}`,
              type: "design",
              title: ref.title,
              sessionId: tabSession(bucket),
              designId: ref.id,
              designPath: ref.path,
            }
        return {
          ...openPanel(state, bucket),
          tabsBySession: {
            ...state.tabsBySession,
            [bucket]: existing ? tabs.map((t) => (t === existing ? tab : t)) : [...tabs, tab],
          },
          activeTabBySession: { ...state.activeTabBySession, [bucket]: tab.id },
        }
      }),

    // Same reasoning as openDesignTab: the deck is a PROJECT resource
    // (conversation, in chat mode), not a message one — the tab is born from main's event
    // that registered the folder. One per conversation, not one in the world: the other
    // chat's stays where it is.
    openSlidesTab: (ref) =>
      set((state) => {
        const bucket = ref.sessionId ?? ORPHAN_KEY
        const tabs = state.tabsBySession[bucket] ?? []
        const existing = tabs.find((t) => t.type === "slides" && t.slidesId === ref.id)
        const tab: PanelTab = existing
          ? { ...existing, slidesEntry: ref.entry, slidesPath: ref.path ?? existing.slidesPath }
          : {
              id: `slides-${nextTabId()}`,
              type: "slides",
              title: ref.title,
              sessionId: tabSession(bucket),
              slidesId: ref.id,
              slidesEntry: ref.entry,
              slidesPath: ref.path,
            }
        return {
          ...openPanel(state, bucket),
          tabsBySession: {
            ...state.tabsBySession,
            [bucket]: existing ? tabs.map((t) => (t === existing ? tab : t)) : [...tabs, tab],
          },
          activeTabBySession: { ...state.activeTabBySession, [bucket]: tab.id },
        }
      }),

    // The presentation is a tab SEPARATE from the editing one: the user compares the
    // running prototype with the canvas side by side. One per canvas — Play from another
    // artboard reuses the tab and only swaps the starting screen.
    openDesignPlayTab: (designId, file, fullscreen) =>
      set((state) => {
        // Play comes from the tab that is on the SCREEN, so the presentation is born in
        // the screen's bucket — even if the same canvas is open in another
        // conversation, where the tab over there is not touched.
        const bucket = state.uiBucket
        const tabs = state.tabsBySession[bucket] ?? []
        const source = tabs.find((t) => t.type === "design" && !t.designPlay && t.designId === designId)
        const existing = tabs.find((t) => t.type === "design" && t.designPlay && t.designId === designId)
        if (existing) {
          return {
            ...openPanel(state, bucket),
            tabsBySession: {
              ...state.tabsBySession,
              [bucket]: tabs.map((t) =>
                t === existing ? { ...t, designPlay: file, designFullscreen: fullscreen ?? t.designFullscreen } : t,
              ),
            },
            activeTabBySession: { ...state.activeTabBySession, [bucket]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `design-play-${nextTabId()}`,
          type: "design",
          title: `${source?.title ?? "Design"} ▶`,
          sessionId: tabSession(bucket),
          designId,
          designPath: source?.designPath,
          designPlay: file,
          designFullscreen: fullscreen,
        }
        return {
          ...openPanel(state, bucket),
          tabsBySession: { ...state.tabsBySession, [bucket]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [bucket]: tab.id },
        }
      }),

    openDocumentTab: (sessionId, ref) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        // One tab per document, as in the artifact: the document is one, and
        // opening the same one twice would give two editors over the same file.
        const existing = tabs.find((t) => t.type === "document" && t.documentId === ref.documentId)
        if (existing) {
          return {
            ...openPanel(state, sessionId),
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `document-${nextTabId()}`,
          type: "document",
          title: ref.title,
          sessionId: tabSession(sessionId),
          documentId: ref.documentId,
        }
        return {
          ...openPanel(state, sessionId),
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    openSourceTab: (sessionId, ref) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        // One tab per document: clicking another citation of the SAME file
        // reuses the tab and only swaps the highlighted stretch — stacking one tab per
        // citation would fill the panel in an answer with ten references.
        const existing = tabs.find((t) => t.type === "source" && t.sourceDocId === ref.docId)
        const patch = {
          sourcePage: ref.page,
          sourceFromLine: ref.fromLine,
          sourceToLine: ref.toLine,
        }
        if (existing) {
          return {
            ...openPanel(state, sessionId),
            tabsBySession: {
              ...state.tabsBySession,
              [sessionId]: tabs.map((t) => (t.id === existing.id ? { ...t, ...patch } : t)),
            },
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `source-${nextTabId()}`,
          type: "source",
          title: ref.title,
          sessionId: tabSession(sessionId),
          sourceDocId: ref.docId,
          ...patch,
        }
        return {
          ...openPanel(state, sessionId),
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    openMemoryTab: (sessionId, ref) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        // One tab per memory: the same citation clicked twice focuses the
        // existing tab, and two different memories live together for comparison.
        const existing = tabs.find((t) => t.type === "memory" && t.memoryId === ref.memoryId)
        if (existing) {
          return {
            ...openPanel(state, sessionId),
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `memory-${nextTabId()}`,
          type: "memory",
          title: ref.title,
          sessionId: tabSession(sessionId),
          memoryId: ref.memoryId,
        }
        return {
          ...openPanel(state, sessionId),
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    openRoutineTab: (sessionId, ref) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        const existing = tabs.find((t) => t.type === "routine" && t.routineId === ref.routineId)
        if (existing) {
          return {
            ...openPanel(state, sessionId),
            tabsBySession: {
              ...state.tabsBySession,
              // The title follows the routine if it was renamed since the tab opened.
              [sessionId]: tabs.map((t) => (t.id === existing.id ? { ...t, title: ref.title } : t)),
            },
            activeTabBySession: { ...state.activeTabBySession, [sessionId]: existing.id },
          }
        }
        const tab: PanelTab = {
          id: `routine-${nextTabId()}`,
          type: "routine",
          title: ref.title,
          sessionId: tabSession(sessionId),
          routineId: ref.routineId,
        }
        return {
          ...openPanel(state, sessionId),
          tabsBySession: { ...state.tabsBySession, [sessionId]: [...tabs, tab] },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: tab.id },
        }
      }),

    adoptOrphanTabs: (sessionId) =>
      set((state) => {
        const orphans = state.tabsBySession[ORPHAN_KEY]
        if (!orphans || orphans.length === 0) return state
        // The new session has no tabs; if it did, its own rule — the orphan is
        // a draft, it cannot overwrite what already exists.
        if ((state.tabsBySession[sessionId] ?? []).length > 0) return state
        const tabsBySession = { ...state.tabsBySession }
        delete tabsBySession[ORPHAN_KEY]
        tabsBySession[sessionId] = orphans.map((tab) =>
          // The pending chat tab keeps pointing to what it created.
          tab.sessionId || tab.pending ? tab : { ...tab, sessionId },
        )
        const activeTabBySession = { ...state.activeTabBySession }
        activeTabBySession[sessionId] = activeTabBySession[ORPHAN_KEY] ?? null
        delete activeTabBySession[ORPHAN_KEY]
        // The panel that was open in the draft stays open in the session that
        // was born — otherwise the first message would close the tab the new chat
        // was already showing.
        const openBySession = { ...state.openBySession }
        if (openBySession[ORPHAN_KEY]) openBySession[sessionId] = true
        return { tabsBySession, activeTabBySession, openBySession }
      }),

    getTabs: (sessionId) => get().tabsBySession[sessionId] ?? [],

    getActiveTabId: (sessionId) => get().activeTabBySession[sessionId] ?? null,

    renameChatTabs: (sessionId, title) =>
      set((state) => {
        let changed = false
        const tabsBySession: Record<string, PanelTab[]> = {}
        for (const [sk, tabs] of Object.entries(state.tabsBySession)) {
          const next = tabs.map((t) =>
            t.sessionId === sessionId && t.type === "chat" && t.title !== title ? { ...t, title } : t,
          )
          if (next.some((t, i) => t !== tabs[i])) changed = true
          tabsBySession[sk] = next
        }
        return changed ? { tabsBySession } : state
      }),

    setTabUrl: (sessionId, tabId, url) =>
      set((state) => {
        const tabs = state.tabsBySession[sessionId]
        if (!tabs) return state
        const index = tabs.findIndex((t) => t.id === tabId)
        if (index < 0 || tabs[index].url === url) return state
        const next = [...tabs]
        next[index] = { ...next[index], url }
        return { tabsBySession: { ...state.tabsBySession, [sessionId]: next } }
      }),

    agentBrowser: {},

    ensureAgentBrowserTab: (sessionId, url) => {
      if (!sessionId) return
      set((state) => {
        const tabs = state.tabsBySession[sessionId] ?? []
        const id = "browser-agent"
        const existing = tabs.find((t) => t.id === id)
        let nextTabs = tabs
        if (!existing) {
          nextTabs = [...tabs, { id, type: "browser", title: "Browser", url }]
        } else if (url && existing.url !== url) {
          nextTabs = tabs.map((t) => (t.id === id ? { ...t, url } : t))
        }
        const activeId = state.activeTabBySession[sessionId] ?? id
        return {
          tabsBySession: { ...state.tabsBySession, [sessionId]: nextTabs },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: activeId },
        }
      })
    },

    openAgentBrowser: (sessionId) => {
      if (!sessionId) return
      const { agentBrowser } = get()
      get().ensureAgentBrowserTab(sessionId, agentBrowser[sessionId]?.url)
      set((state) => openPanel(state, sessionId))
    },

    // Every link click in the terminal creates its own tab ("new tab"
    // semantics, like a real browser) — it does not reuse the agent's tab.
    openTerminalLink: (sessionId, url) =>
      set((state) => {
        const id = `browser-${nextTabId()}`
        const tabs = state.tabsBySession[sessionId] ?? []
        return {
          ...openPanel(state, sessionId),
          // User click (terminal link / process card): the new tab
          // comes to the front, so the selector is no longer showing.
          selectorOpen: false,
          tabsBySession: {
            ...state.tabsBySession,
            [sessionId]: [...tabs, { id, type: "browser", title: "Browser", url }],
          },
          activeTabBySession: { ...state.activeTabBySession, [sessionId]: id },
        }
      }),
    selectMode: false,
    setSelectMode: (value) => set({ selectMode: value }),
    selections: [],
    addSelection: (selection) =>
      set((state) => ({
        selections: [
          ...state.selections,
          { ...selection, id: `sel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` },
        ],
        selectMode: false,
      })),
    removeSelection: (id) =>
      set((state) => ({ selections: state.selections.filter((s) => s.id !== id) })),
    clearSelections: () => set({ selections: [] }),

    quotes: [],
    addQuote: (quote) =>
      set((state) => {
        // A motion instant replaces the previous one (see PanelState.addQuote);
        // document stretches keep accumulating. A design element accumulates,
        // but the SAME element (artboard + path) goes in only once.
        const sameDesign = (q: PanelQuote) =>
          quote.kind === "design" &&
          q.kind === "design" &&
          q.name === quote.name &&
          q.file === quote.file &&
          (q.elementPath ?? []).join(">") === (quote.elementPath ?? []).join(">")
        // The same widget pointed at again replaces its previous chip instead of stacking
        // two identical requests.
        const sameWidget = (q: PanelQuote) =>
          quote.kind === "widget" &&
          q.kind === "widget" &&
          q.fragmentId === quote.fragmentId &&
          q.widgetId === quote.widgetId
        const currentTabs = state.quotes
          .filter((q) => (quote.kind === "motion" ? q.kind !== "motion" : !sameDesign(q)))
          .filter((q) => !sameWidget(q))
        return {
          quotes: [...currentTabs, { ...quote, id: `quote-${Date.now()}-${currentTabs.length}` } as PanelQuote],
        }
      }),
    removeQuote: (id) => set((state) => ({ quotes: state.quotes.filter((q) => q.id !== id) })),
    clearQuotes: () => set({ quotes: [] }),
    viewport: null,
    setViewport: (viewport) => set({ viewport }),
    fullscreen: false,
    setFullscreen: (value) => set({ fullscreen: value }),
    agentActive: false,
    activity: [],
    pushActivity: (label) => {
      markActive()
      set((state) => ({
        activity: [
          { id: `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label, at: Date.now() },
          ...state.activity,
        ].slice(0, 30),
      }))
    },

    applyEvent: (event) => {
      switch (event.type) {
        case "ensure": {
          markActive()
          // Never opens the panel: it only registers the session's agent browser and
          // ensures the tab (the webview itself is created by App.tsx, in the
          // hidden host). The UI shows up when the user clicks the indicator.
          set((state) => ({
            agentBrowser: {
              ...state.agentBrowser,
              [event.sessionId]: {
                url: event.url ?? state.agentBrowser[event.sessionId]?.url ?? "",
                at: Date.now(),
              },
            },
          }))
          get().ensureAgentBrowserTab(event.sessionId, event.url)
          break
        }
        case "resize":
          markActive()
          set({
            viewport:
              event.width && event.height
                ? { width: event.width, height: event.height, label: event.label }
                : null,
          })
          break
        case "fullscreen":
          markActive()
          set({ fullscreen: event.on })
          break
        case "motion":
          markActive()
          // Mirrors the browser "ensure": the event is main's (the agent
          // registered the composition) and opens the tab — here the panel opens on its own,
          // because the composition is what the user asked to see.
          get().openMotionTab({
            id: event.id,
            entry: event.entry,
            title: event.title,
            sessionId: event.sessionId,
            path: event.path,
          })
          break
        case "design":
          markActive()
          // Mirrors the "motion" case: the panel opens on its own because the canvas is
          // what the user asked to see.
          get().openDesignTab({
            id: event.id,
            title: event.title,
            sessionId: event.sessionId,
            path: event.path,
          })
          break
        case "slides":
          markActive()
          // The deck is what the user asked to see — the panel opens on its own,
          // as in motion and design.
          get().openSlidesTab({
            id: event.id,
            entry: event.entry,
            title: event.title,
            sessionId: event.sessionId,
            path: event.path,
          })
          break
        case "fragment":
          if (fragmentClaimer?.({ id: event.id, sessionId: event.sessionId })) break
          markActive()
          get().openFragmentTab({ id: event.id, title: event.title, sessionId: event.sessionId })
          break
        case "pieces-removed":
          get().closeMotionTabs(event.motion)
          get().closeDesignTabs(event.design)
          get().closeSlidesTabs(event.slides)
          break
        case "activity": {
          usePanelStore.getState().pushActivity(event.label)
          // Keeps the session indicator fresh while the agent touches the browser.
          const activitySessionId = event.sessionId
          if (activitySessionId) {
            set((state) => ({
              agentBrowser: {
                ...state.agentBrowser,
                [activitySessionId]: {
                  url: state.agentBrowser[activitySessionId]?.url ?? "",
                  at: Date.now(),
                },
              },
            }))
          }
          break
        }
      }
    },

    openChatTab: (sessionId, title) =>
      set((state) => ({
        // The chat tab is created in the SCREEN's bucket (see RightPanel): it is in it that the
        // panel has to open, even when the requested chat is another one.
        ...openPanel(state, state.uiBucket),
        pendingChatTab: state.pendingChatTab + 1,
        pendingChatTabSession: sessionId,
        pendingChatTabTitle: title,
      })),
    pendingChatTab: 0,
    pendingChatTabSession: undefined,
    pendingChatTabTitle: undefined,

    openDiff: (sessionId, messageId, title) =>
      set((state) => ({
        ...openPanel(state, state.uiBucket),
        pendingDiff: state.pendingDiff + 1,
        pendingDiffSessionId: sessionId,
        pendingDiffMessageId: messageId,
        pendingDiffPipelineId: undefined,
        pendingDiffTaskId: undefined,
        pendingDiffTitle: title,
      })),

    openTaskDiff: (pipelineId, taskId, title) =>
      set((state) => ({
        // The task diff belongs to no session: it opens in the screen's panel.
        ...openPanel(state, state.uiBucket),
        pendingDiff: state.pendingDiff + 1,
        pendingDiffSessionId: undefined,
        pendingDiffMessageId: undefined,
        pendingDiffPipelineId: pipelineId,
        pendingDiffTaskId: taskId,
        pendingDiffTitle: title,
      })),
    pendingDiff: 0,
    pendingDiffSessionId: undefined,
    pendingDiffMessageId: undefined,
    pendingDiffTitle: undefined,

    openChatTabWithPendingInput: (sessionId, title, input) =>
      set((state) => ({
        ...openPanel(state, state.uiBucket),
        pendingInput: { sessionId, text: input },
        pendingChatTab: state.pendingChatTab + 1,
        pendingChatTabSession: sessionId,
        pendingChatTabTitle: title,
      })),
    pendingInput: null,
    setPendingInput: (val) => set({ pendingInput: val }),
  }
})

/**
 * Mirrors the panel to main, for the `read_open_panel` tool.
 *
 * The tabs are per chat session; the agent reads its own session's snapshot. The send
 * is deduplicated per session — the store changes a lot (browser events, activity),
 * and it makes no sense to resend an identical portrait on every tick.
 */
const lastPanelSnapshots = new Map<string, string>()

function emitPanelSnapshots(state: ReturnType<typeof usePanelStore.getState>): void {
  const sessions = new Set([...Object.keys(state.tabsBySession), ...Object.keys(state.activeTabBySession)])
  for (const sessionId of sessions) {
    const tabs = state.tabsBySession[sessionId] ?? []
    const activeTabId = state.activeTabBySession[sessionId] ?? null
    const snapshotTabs: PanelSnapshotTab[] = tabs.map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      artifactId: t.artifactId,
      fragmentId: t.fragmentId,
      motionId: t.motionId,
      motionPath: t.motionPath,
      designId: t.designId,
      designPath: t.designPath,
      slidesId: t.slidesId,
      slidesPath: t.slidesPath,
      slidesEntry: t.slidesEntry,
      documentId: t.documentId,
      url: t.url,
      sourceDocId: t.sourceDocId,
      memoryId: t.memoryId,
      routineId: t.routineId,
    }))
    const key = JSON.stringify({ activeTabId, snapshotTabs })
    if (lastPanelSnapshots.get(sessionId) === key) continue
    lastPanelSnapshots.set(sessionId, key)
    const snapshot: PanelSnapshot = { sessionId, activeTabId, tabs: snapshotTabs, updatedAt: Date.now() }
    // The store is also imported in tests (node, without DOM): without a renderer, without
    // a snapshot — and that is fine, the tool only answers what arrived.
    if (typeof window === 'undefined') return
    window.ipcRenderer?.send("panel:snapshot", snapshot)
  }
}

usePanelStore.subscribe(emitPanelSnapshots)
queueMicrotask(() => emitPanelSnapshots(usePanelStore.getState()))

