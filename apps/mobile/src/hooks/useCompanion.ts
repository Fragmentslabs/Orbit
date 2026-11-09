import { useEffect } from 'react'
import { AppState } from 'react-native'
import type {
  AppPreferences,
  SessionModelChangeEvent,
  RotationChangeEvent,
  ChatEventMessage,
  PipelineEventMessage,
  RoutineEventMessage,
  SessionModeOverrides,
  SessionPrefsSnapshot,
  WorkerConfigSnapshot,
  ReasoningPrefsMap,
  MessageQueueChangeEvent,
} from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
import { useMessageQueueStore } from '../stores/message-queue-store'
import { useRecentConnectionsStore } from '~/stores/recent-connections-store'
import { useSessionStore } from '../stores/session-store'
import { useSettingsStore } from '../stores/settings-store'
import { useSessionModelPrefs } from '~/stores/session-model-prefs'
import { useModelRotationStore } from '~/stores/model-rotation-store'
import { useSessionTools } from '~/stores/session-tools'
import { applyRemoteModes, fetchSessionModes } from '~/stores/session-modes-sync'
import { applyRemoteSessionPrefs, fetchSessionPrefs } from '~/stores/session-prefs-sync'
import { applyReasoningPrefs, fetchReasoningPrefs } from '~/stores/reasoning-sync'
import { applyAppPreferences, hydrateAppPreferences } from '~/stores/prefs-sync'
import { useRoutinesStore } from '~/stores/routines-store'
import { usePipelineStore } from '~/stores/pipeline-store'

/**
 * Hook that orchestrates the WS + HTTP connection with the desktop.
 *
 * Usage: call `useCompanion()` in the root layout (or provider).
 * It:
 *  1. Loads the saved config and reconnects automatically
 *  2. Listens to WS events and dispatches them to the stores
 *  3. Does the initial fetch of sessions/settings on connect
 */
export function useCompanion() {
  // ─── Automatic connection on mount ─────────────────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // Model catalog cache: paints the UI instantly even before
    // connecting, while the real fetchCatalog() (post-connection) updates it.
    void useSettingsStore.getState().hydrateCatalogCache()

    // Tries to load the saved config and reconnect
    void conn.loadConfig().then((saved) => {
      if (saved) {
        conn.connect(saved)
      }
    })

    // Cleanup: closes the socket without erasing the saved config — in dev React
    // unmounts/remounts the root (double-invoke), and disconnect() here erased
    // the credentials and killed the automatic reconnection.
    return () => {
      conn.shutdown()
    }
  }, [])

  // ─── Return from the background ────────────────────────────────────────
  // iOS/Android suspend the app and the socket dies without warning: it comes back
  // looking connected and everything that is sent vanishes. On returning to the foreground the
  // client checks whether the desktop responds (and reconnects if it does not).

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') useConnectionStore.getState().wsClient.checkAlive()
    })
    return () => sub.remove()
  }, [])

  // ─── Listens to WS state changes ───────────────────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    const unsub = conn.onConnectionChange((state) => {
      if (state.status === 'connected') {
        // Persists the device token issued by the desktop — it is what
        // allows reconnecting later without a PIN (the PIN expires in 5 min).
        const store = useConnectionStore.getState()
        const config = store.config
          ? { ...store.config, token: state.deviceToken ?? store.config.token }
          : null
        if (config) {
          if (config !== store.config) {
            useConnectionStore.setState({ config })
          }
          void store.saveConfig(config)
          // state.deviceName comes from auth:ok — and it is the name of the DESKTOP. The
          // config.deviceName is the one of this phone, which is no use here.
          void useRecentConnectionsStore.getState().addRecent(config, state.deviceName)
        }
        // Fetch initial data
        void useSessionStore.getState().fetchSessions()
        // The open chat may have gained cards (question, permission, plan)
        // while the socket was out: the live events went by without
        // anyone listening, so the session state is fetched again from the desktop.
        const activeId = useSessionStore.getState().activeSessionId
        if (activeId) void useSessionStore.getState().fetchMessages(activeId)
        // Who is still running on the desktop — without this, connecting in the middle of
        // an execution shows the conversation stalled (and reconnecting after it
        // finishes leaves the spinner stuck).
        void useSessionStore.getState().fetchRunningSessions()
        // Shared queue: the mirror of the desktop queue, and the delivery of what
        // was typed here without a connection (the desktop sends it when the session becomes
        // free — the phone never fires the queue on its own).
        void useMessageQueueStore.getState().fetchRemote()
        void useMessageQueueStore.getState().flushOutbox()
        void useSessionStore.getState().fetchFolders()
        void useSettingsStore.getState().fetchSelectedModel()
        void useSettingsStore.getState().fetchPreferences()
        void useSettingsStore.getState().fetchCatalog()
        void useSettingsStore.getState().fetchConnectedProviders()
        // Model overrides per session (snapshot of the desktop renderer)
        void useSessionModelPrefs.getState().hydrate()
        // Model rotations (list + per-chat choice) — they live on the desktop
        void useModelRotationStore.getState().hydrate()
        // Active modes per chat (same path: snapshot of the renderer)
        void fetchSessionModes()
        // Tools (MCP servers) per chat — same path again, so the chat opens on the
        // phone with the same tools that are on in the desktop
        void useSessionTools.getState().hydrate()
        // Thinking per model (toggle + variant) — it lives in the desktop renderer
        void fetchReasoningPrefs()
        // Thinking and autonomy PER CHAT (same path: snapshot of the renderer)
        void fetchSessionPrefs()
        // Subagent/orchestration and vision config (global, lives on the desktop)
        void useSettingsStore.getState().fetchWorkerConfig()
        // Desktop preferences win: on connection the phone adopts the ones from there
        // (mode defaults, permission, automatic folders).
        void hydrateAppPreferences()
      } else if (state.status === 'disconnected' && state.errorReason === 'invalid_pin') {
        // PIN expired (5 min TTL on the desktop) — forgets the saved config so as
        // not to get stuck in an auto-reconnect loop that always fails
        void useConnectionStore.getState().clearSavedConfig()
      }
    })

    return unsub
  }, [])

  // ─── Listens to WS events and dispatches to stores ─────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // chat:event → session store
    const unsubChat = conn.onEvent('chat:event', (event) => {
      const msg = event as ChatEventMessage
      const chatEvent = msg.event
      // "folders" is the only event without a sessionId (full replacement of the list)
      if (chatEvent && typeof chatEvent === 'object' && ('sessionId' in chatEvent || 'folders' in chatEvent)) {
        useSessionStore.getState().applyChatEvent(chatEvent as any)
      }
    })

    // session:model-change → per-session model overrides coming from the desktop
    const unsubModels = conn.onEvent('session:model-change', (event) => {
      const msg = event as Partial<SessionModelChangeEvent>
      if (msg?.overrides) {
        useSessionModelPrefs.getState().applySync(msg.overrides)
      }
    })

    // rotation:change → rotations (list + per-chat choice) changed on the
    // desktop or on another paired device
    const unsubRotation = conn.onEvent('rotation:change', (event) => {
      const msg = event as Partial<RotationChangeEvent>
      if (msg?.config) useModelRotationStore.getState().applySync(msg.config)
    })

    // session:mode-change → active modes per chat changed on the desktop
    const unsubModes = conn.onEvent('session:mode-change', (event) => {
      const msg = event as { overrides?: SessionModeOverrides }
      if (msg?.overrides) applyRemoteModes(msg.overrides, true)
    })

    // session:tools-change → tools (MCP servers) of a chat changed on the desktop
    const unsubTools = conn.onEvent('session:tools-change', (event) => {
      const msg = event as { overrides?: Record<string, string[] | null> }
      if (msg?.overrides) useSessionTools.getState().applySync(msg.overrides, true)
    })

    // session:prefs-change → thinking/autonomy of a chat changed on the desktop
    const unsubSessionPrefs = conn.onEvent('session:prefs-change', (event) => {
      const msg = event as { prefs?: SessionPrefsSnapshot }
      if (msg?.prefs) applyRemoteSessionPrefs(msg.prefs, true)
    })

    // reasoning:change → per-model thinking changed on the desktop (or by the
    // toggle here itself, which comes back in the broadcast as confirmation)
    const unsubReasoning = conn.onEvent('reasoning:change', (event) => {
      const msg = event as { prefs?: ReasoningPrefsMap }
      if (msg?.prefs) void applyReasoningPrefs(msg.prefs, true)
    })

    // worker-config:change → worker model / vision model of the desktop
    const unsubWorkerConfig = conn.onEvent('worker-config:change', (event) => {
      const msg = event as { config?: WorkerConfigSnapshot }
      if (msg?.config) useSettingsStore.getState().applyWorkerConfigSync(msg.config)
    })

    // prefs:change → app preferences (mode defaults, permission, automatic
    // folders) changed on the desktop or on another paired device
    const unsubPrefs = conn.onEvent('prefs:change', (event) => {
      const msg = event as { prefs?: AppPreferences }
      if (msg?.prefs) applyAppPreferences(msg.prefs)
    })

    // queue:change → shared message queue, changed on the desktop or on
    // another device
    const unsubQueue = conn.onEvent('queue:change', (event) => {
      const msg = event as Partial<MessageQueueChangeEvent>
      if (msg?.queues) useMessageQueueStore.getState().applySync(msg.queues)
    })

    // routines:event → routines store (create/edit/delete/execution by the scheduler)
    const unsubRoutines = conn.onEvent('routines:event', (event) => {
      const msg = event as RoutineEventMessage
      if (msg?.event) {
        useRoutinesStore.getState().applyEvent(msg.event)
      }
    })

    // pipeline:event → pipeline store (tasks, phases, queue, live progress)
    const unsubPipeline = conn.onEvent('pipeline:event', (event) => {
      const msg = event as PipelineEventMessage
      if (msg?.event) {
        usePipelineStore.getState().applyEvent(msg.event)
      }
    })

    return () => {
      unsubChat()
      unsubModels()
      unsubRotation()
      unsubModes()
      unsubTools()
      unsubSessionPrefs()
      unsubReasoning()
      unsubWorkerConfig()
      unsubPrefs()
      unsubQueue()
      unsubRoutines()
      unsubPipeline()
    }
  }, [])
}

