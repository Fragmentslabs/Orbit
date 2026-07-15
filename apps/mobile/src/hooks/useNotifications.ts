import { useEffect } from 'react'
import type { ChatEventMessage, PendingAskNotification } from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
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
      const ask = event as PendingAskNotification
      const sessions = useSessionStore.getState().sessions
      const session = sessions.find((s) => s.id === ask.sessionId)
      const sessionTitle = session?.title ?? 'Sessão'

      void scheduleLocalNotification({
        title: '❓ Pergunta pendente',
        body: `${sessionTitle}: ${ask.title}`,
        data: { type: 'pending-ask', sessionId: ask.sessionId },
      })
    })

    // notify:new-message → notificação de nova mensagem (se não estiver na sessão ativa)
    const unsubMsg = conn.onEvent('notify:new-message', (event) => {
      const msg = event as { sessionId?: string; title?: string }
      if (!msg.sessionId) return

      const activeSessionId = useSessionStore.getState().activeSessionId
      // Só notifica se a mensagem é de outra sessão
      if (msg.sessionId === activeSessionId) return

      const sessions = useSessionStore.getState().sessions
      const session = sessions.find((s) => s.id === msg.sessionId)
      const sessionTitle = msg.title ?? session?.title ?? 'Sessão'

      void scheduleLocalNotification({
        title: '💬 Nova mensagem',
        body: sessionTitle,
        data: { type: 'new-message', sessionId: msg.sessionId },
      })
    })

    // chat:event com status=error → notificação de erro
    const unsubChat = conn.onEvent('chat:event', (event) => {
      const msg = event as ChatEventMessage
      const chatEvent = msg.event
      if (
        chatEvent &&
        typeof chatEvent === 'object' &&
        'status' in chatEvent &&
        (chatEvent as any).status === 'error'
      ) {
        void scheduleLocalNotification({
          title: '⚠️ Erro no chat',
          body: (chatEvent as any).error ?? 'Ocorreu um erro durante o chat.',
          data: { type: 'chat-error', sessionId: (chatEvent as any).sessionId },
        })
      }
    })

    return () => {
      unsubAsk()
      unsubMsg()
      unsubChat()
    }
  }, [])

  // ─── Handle notificação tocada ──────────────────────────────────────────

  useEffect(() => {
    const unsub = addNotificationResponseListener((response) => {
      const data = response.notification.request.content.data as Record<string, string>

      if (data.type === 'pending-ask' && data.sessionId) {
        // Navega para a sessão (o app router vai resolver)
        useSessionStore.getState().selectSession(data.sessionId)
      } else if (data.type === 'new-message' && data.sessionId) {
        useSessionStore.getState().selectSession(data.sessionId)
      } else if (data.type === 'chat-error' && data.sessionId) {
        useSessionStore.getState().selectSession(data.sessionId)
      }
    })

    return unsub
  }, [])
}
