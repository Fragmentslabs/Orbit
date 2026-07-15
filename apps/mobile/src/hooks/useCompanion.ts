import { useEffect, useRef } from 'react'
import type { CompanionEvent, ChatEventMessage, PendingAskNotification } from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
import { useSessionStore } from '../stores/session-store'
import { useChatStore } from '../stores/chat-store'
import { useSettingsStore } from '../stores/settings-store'

/**
 * Hook que orquestra a conexão WS + HTTP com o desktop.
 *
 * Uso: chame `useCompanion()` no root layout (ou provider).
 * Ele:
 *  1. Carrega config salva e reconecta automaticamente
 *  2. Escuta eventos WS e despacha para os stores
 *  3. Faz fetch inicial de sessões/settings ao conectar
 */
export function useCompanion() {
  const initialFetchDone = useRef(false)

  // ─── Conexão automática ao montar ──────────────────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // Tenta carregar config salva e reconectar
    void conn.loadConfig().then((saved) => {
      if (saved) {
        conn.connect(saved)
      }
    })

    // Cleanup: desconecta ao desmontar
    return () => {
      conn.disconnect()
    }
  }, [])

  // ─── Escuta mudanças de estado WS ──────────────────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    const unsub = conn.onConnectionChange((state) => {
      if (state.status === 'connected') {
        // Reconectou — faz fetch inicial (uma única vez, ou a cada reconexão)
        initialFetchDone.current = true
        void useSessionStore.getState().fetchSessions()
        void useSettingsStore.getState().fetchSelectedModel()
        void useSettingsStore.getState().fetchPreferences()
      }

      if (state.status === 'disconnected') {
        initialFetchDone.current = false
      }
    })

    return unsub
  }, [])

  // ─── Escuta eventos WS e despacha para stores ──────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // chat:event → session store
    const unsubChat = conn.onEvent('chat:event', (event) => {
      const chatEvent = (event as ChatEventMessage).event
      if (chatEvent && typeof chatEvent === 'object' && 'sessionId' in chatEvent) {
        useSessionStore.getState().applyChatEvent(chatEvent as any)
      }
    })

    // notify:pending-ask → chat store
    const unsubAsk = conn.onEvent('notify:pending-ask', (event) => {
      const ask = event as PendingAskNotification
      useChatStore.getState().addPendingAsk(ask.sessionId, {
        requestId: ask.requestId,
        kind: ask.kind,
        title: ask.title,
        questions: ask.questions as any,
      } as any)
    })

    // notify:new-message → pode ser usado para notificações push (fase 8)

    return () => {
      unsubChat()
      unsubAsk()
    }
  }, [])
}
