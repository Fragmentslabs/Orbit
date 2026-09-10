import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ChatEventMessage,
  PendingAskNotification,
  NewMessageNotification,
  ChatStatus,
  MessageErrorKind,
} from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
import { useNotificationPrefsStore } from '../stores/notification-prefs-store'
import { useSessionStore } from '../stores/session-store'
import {
  configureNotifications,
  scheduleLocalNotification,
  addNotificationResponseListener,
  clearBadge,
} from '../lib/notifications'

/**
 * Hook que configura notificações locais reativas aos eventos WS.
 *
 * - Notifica quando há pending ask
 * - Notifica quando há nova mensagem (em sessão inativa)
 * - Notifica em erros de chat
 * - Limpa badge ao abrir o app
 */
export function useNotifications() {
  const { t } = useTranslation()

  // ─── Configura handler de exibição ───────────────────────────────────────

  useEffect(() => {
    configureNotifications()
  }, [])

  // ─── Limpa badge ao montar ──────────────────────────────────────────────

  useEffect(() => {
    void clearBadge()
  }, [])

  // ─── Escuta eventos WS e dispara notificações ───────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // notify:pending-ask → notificação de pergunta pendente
    const unsubAsk = conn.onEvent('notify:pending-ask', (event) => {
      const prefs = useNotificationPrefsStore.getState().prefs
      if (!prefs.pendingAsk) return

      const ask = event as PendingAskNotification
      const sessions = useSessionStore.getState().sessions
      const session = sessions.find((s) => s.id === ask.sessionId)
      const sessionTitle = session?.title ?? t('notifications.defaultSessionTitle')
      // O desktop manda `title` vazio quando o pedido não traz texto próprio
      // (claim/pergunta) — o fallback é nosso, no idioma do celular.
      const pedido =
        ask.title ||
        (ask.kind === 'permission'
          ? t('notifications.permissionFallback')
          : t('notifications.questionFallback'))

      void scheduleLocalNotification({
        title: t('notifications.pendingQuestionTitle'),
        body: `${sessionTitle}: ${pedido}`,
        data: { type: 'pending-ask', sessionId: ask.sessionId },
      })
    })

    // notify:new-message → notificação de nova mensagem (se não estiver na sessão ativa)
    const unsubMsg = conn.onEvent('notify:new-message', (event) => {
      const prefs = useNotificationPrefsStore.getState().prefs
      if (!prefs.newMessage) return

      const msg = event as NewMessageNotification
      if (!msg.sessionId) return

      const activeSessionId = useSessionStore.getState().activeSessionId
      if (msg.sessionId === activeSessionId) return

      const body = msg.messagePreview || msg.sessionTitle || t('notifications.newMessageBody')

      void scheduleLocalNotification({
        title: t('notifications.newMessageTitle'),
        body,
        data: { type: 'new-message', sessionId: msg.sessionId },
      })
    })

    // chat:event com status=error → notificação de erro
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
        // Kind conhecido → explicação traduzida e curta; o texto cru de
        // `error` (provedor ou engine) é diagnóstico e não se traduz.
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

    return () => {
      unsubAsk()
      unsubMsg()
      unsubChat()
    }
  }, [t])

  // ─── Handle notificação tocada ──────────────────────────────────────────

  useEffect(() => {
    // Carregamento condicional de módulo opcional: import estático não
    // serve aqui (o módulo pode não existir no runtime — Expo Go, web,
    // build sem o nativo) e é justamente por isso que o require está
    // dentro do try/if.
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
