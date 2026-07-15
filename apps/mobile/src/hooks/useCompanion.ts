import { useEffect } from 'react'
import type { ChatEventMessage, PendingAskNotification } from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
import { useRecentConnectionsStore } from '~/stores/recent-connections-store'
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
  // ─── Conexão automática ao montar ──────────────────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // Tenta carregar config salva e reconectar
    void conn.loadConfig().then((saved) => {
      if (saved) {
        conn.connect(saved)
      }
    })

    // Cleanup: fecha o socket sem apagar a config salva — em dev o React
    // desmonta/remonta o root (double-invoke), e disconnect() aqui apagava
    // as credenciais e matava a reconexão automática.
    return () => {
      conn.shutdown()
    }
  }, [])

  // ─── Escuta mudanças de estado WS ──────────────────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    const unsub = conn.onConnectionChange((state) => {
      if (state.status === 'connected') {
        // Save to recent connections
        const config = useConnectionStore.getState().config
        if (config) {
          void useRecentConnectionsStore.getState().addRecent(config)
        }
        // Fetch initial data
        void useSessionStore.getState().fetchSessions()
        void useSettingsStore.getState().fetchSelectedModel()
        void useSettingsStore.getState().fetchPreferences()
      } else if (state.status === 'disconnected' && state.error === 'invalid_pin') {
        // PIN expirou (TTL de 5 min no desktop) — esquece a config salva para
        // não ficar preso num loop de auto-reconexão que sempre falha
        void useConnectionStore.getState().clearSavedConfig()
      }
    })

    return unsub
  }, [])

  // ─── Escuta eventos WS e despacha para stores ──────────────────────────

  useEffect(() => {
    const conn = useConnectionStore.getState()

    // chat:event → session store
    const unsubChat = conn.onEvent('chat:event', (event) => {
      const msg = event as ChatEventMessage
      const chatEvent = msg.event
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
      })
    })

    return () => {
      unsubChat()
      unsubAsk()
    }
  }, [])
}
