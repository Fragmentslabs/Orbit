import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ChatEventMessage,
  PendingAskNotification,
  NewMessageNotification,
  ChatStatus,
  MessageErrorKind,
  RoutineEventMessage,
} from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
import { useRoutinesStore } from '../stores/routines-store'
import { useNotificationPrefsStore } from '../stores/notification-prefs-store'
import { useSessionStore } from '../stores/session-store'
import {
  configureNotifications,
  scheduleLocalNotification,
  addNotificationResponseListener,
  clearBadge,
} from '../lib/notifications'

/**
 * Hook that sets up local notifications reactive to the WS events.
 *
 * - Notifies when there is a pending ask
 * - Notifies when there is a new message (in an inactive session)
 * - Notifies on chat errors
 * - Clears the badge when the app opens
 */
export function useNotifications() {
  const { t } = useTranslation()

  // ─── Sets up the display handler ─────────────────────────────────────────

  useEffect(() => {
    configureNotifications()
  }, [])

  // ─── Clears the badge on mount ──────────────────────────────────────────

  useEffect(() => {
    void clearBadge()
  }, [])

  // ─── Listens to WS events and fires notifications ───────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // notify:pending-ask → notification of a pending question
    const unsubAsk = conn.onEvent('notify:pending-ask', (event) => {
      const prefs = useNotificationPrefsStore.getState().prefs
      if (!prefs.pendingAsk) return

      const ask = event as PendingAskNotification
      const sessions = useSessionStore.getState().sessions
      const session = sessions.find((s) => s.id === ask.sessionId)
      const sessionTitle = session?.title ?? t('notifications.defaultSessionTitle')
      // The desktop sends an empty `title` when the request brings no text of its own
      // (claim/question) — the fallback is ours, in the phone's language.
      const request =
        ask.title ||
        (ask.kind === 'permission'
          ? t('notifications.permissionFallback')
          : t('notifications.questionFallback'))

      void scheduleLocalNotification({
        title: t('notifications.pendingQuestionTitle'),
        body: `${sessionTitle}: ${request}`,
        data: { type: 'pending-ask', sessionId: ask.sessionId },
      })
    })

    // notify:new-message → notification of a new message (if not in the active session)
    const unsubMsg = conn.onEvent('notify:new-message', (event) => {
      const prefs = useNotificationPrefsStore.getState().prefs
      if (!prefs.newMessage) return

      const msg = event as NewMessageNotification
      if (!msg.sessionId) return

      const activeSessionId = useSessionStore.getState().activeSessionId
      if (msg.sessionId === activeSessionId) return

      // The end of a routine's execution has its own notification (below): this one would be
      // the same news twice.
      if (prefs.routineRun && useRoutinesStore.getState().runs.some((r) => r.sessionId === msg.sessionId)) return

      const body = msg.messagePreview || msg.sessionTitle || t('notifications.newMessageBody')

      void scheduleLocalNotification({
        title: t('notifications.newMessageTitle'),
        body,
        data: { type: 'new-message', sessionId: msg.sessionId },
      })
    })

    // chat:event with status=error → error notification
    const unsubChat = conn.onEvent('chat:event', (event) => {
      const prefs = useNotificationPrefsStore.getState().prefs
      if (!prefs.chatError) return

      const msg = event as ChatEventMessage
      const chatEvent = msg.event as {
        type: string
        sessionId: string
        status: ChatStatus
        error?: string
        errorKind?: MessageErrorKind
      } | null
      if (chatEvent?.type === 'status' && chatEvent.status === 'error') {
        // Known kind → short translated explanation; the raw text of
        // `error` (provider or engine) is diagnostic and is not translated.
        const body =
          chatEvent.errorKind && chatEvent.errorKind !== 'unknown'
            ? t(`notifications.chatErrorKind.${chatEvent.errorKind}`)
            : chatEvent.error || t('notifications.chatErrorBody')
        void scheduleLocalNotification({
          title: t('notifications.chatErrorTitle'),
          body,
          data: { type: 'chat-error', sessionId: chatEvent.sessionId },
        })
      }
    })

    // routines:event → a routine finished running (the event of the run, already closed)
    const notified = new Set<string>()
    const unsubRoutine = conn.onEvent('routines:event', (event) => {
      const routineEvent = (event as RoutineEventMessage)?.event
      if (routineEvent?.type !== 'run') return
      const run = routineEvent.run
      if (run.status === 'running' || !run.completedAt) return
      // Each execution notifies once, and only if it just ended (not a replay of old history).
      if (notified.has(run.sessionId) || Date.now() - run.completedAt > 5 * 60_000) return
      notified.add(run.sessionId)

      if (!useNotificationPrefsStore.getState().prefs.routineRun) return
      if (useSessionStore.getState().activeSessionId === run.sessionId) return

      const routine = useRoutinesStore.getState().routines.find((r) => r.id === run.routineId)
      const title = routine?.title ?? t('notifications.routineFallbackTitle')
      const failed = run.status === 'error'
      void scheduleLocalNotification({
        title: failed ? t('notifications.routineFailedTitle', { title }) : t('notifications.routineDoneTitle', { title }),
        body: failed ? run.error || t('notifications.routineFailedBody') : t('notifications.routineDoneBody'),
        data: { type: 'routine-run', sessionId: run.sessionId, routineId: run.routineId },
      })
    })

    return () => {
      unsubAsk()
      unsubMsg()
      unsubChat()
      unsubRoutine()
    }
  }, [t])

  // ─── Handles a tapped notification ──────────────────────────────────────

  useEffect(() => {
    // Conditional loading of an optional module: a static import does not
    // work here (the module may not exist at runtime — Expo Go, web,
    // build without the native part) and that is exactly why the require is
    // inside the try/if.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { router } = require('expo-router')

    const unsub = addNotificationResponseListener((response) => {
      const data = response.notification.request.content.data as Record<string, string>

      if (data.sessionId) {
        useSessionStore.getState().selectSession(data.sessionId)
        router.replace({ pathname: '/(main)/chat/[id]', params: { id: data.sessionId } })
      }
    })

    return unsub
  }, [])
}
