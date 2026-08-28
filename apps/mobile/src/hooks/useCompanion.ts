import { useEffect } from 'react'
import type { ChatEventMessage, EsteiraEventMessage, RotinaEventMessage } from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
import { useMessageQueueStore } from '../stores/message-queue-store'
import { useRecentConnectionsStore } from '~/stores/recent-connections-store'
import { useSessionStore } from '../stores/session-store'
import { useSettingsStore } from '../stores/settings-store'
import { useSessionModelPrefs } from '~/stores/session-model-prefs'
import { useRotinasStore } from '~/stores/rotinas-store'
import { useEsteiraStore } from '~/stores/esteira-store'

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

    // Cache do catálogo de modelos: pinta a UI instantaneamente mesmo antes
    // de conectar, enquanto o fetchCatalog() real (pós-conexão) atualiza.
    void useSettingsStore.getState().hydrateCatalogCache()

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
        // Persiste o token de dispositivo emitido pelo desktop — é ele que
        // permite reconectar depois sem PIN (o PIN expira em 5 min).
        const store = useConnectionStore.getState()
        const config = store.config
          ? { ...store.config, token: state.deviceToken ?? store.config.token }
          : null
        if (config) {
          if (config !== store.config) {
            useConnectionStore.setState({ config })
          }
          void store.saveConfig(config)
          // state.deviceName vem do auth:ok — e o nome do DESKTOP. O
          // config.deviceName e o deste celular, que nao serve aqui.
          void useRecentConnectionsStore.getState().addRecent(config, state.deviceName)
        }
        // Fetch initial data
        void useSessionStore.getState().fetchSessions()
        void useSessionStore.getState().fetchFolders()
        void useSettingsStore.getState().fetchSelectedModel()
        void useSettingsStore.getState().fetchPreferences()
        void useSettingsStore.getState().fetchCatalog()
        void useSettingsStore.getState().fetchConnectedProviders()
        // Overrides de modelo por sessão (snapshot do renderer do desktop)
        void useSessionModelPrefs.getState().hydrate()
        // Processa fila de mensagens offline
        useMessageQueueStore.getState().processAllQueues()
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
      // "folders" é o único evento sem sessionId (substituição completa da lista)
      if (chatEvent && typeof chatEvent === 'object' && ('sessionId' in chatEvent || 'folders' in chatEvent)) {
        useSessionStore.getState().applyChatEvent(chatEvent as any)
      }
    })

    // session:model-change → overrides de modelo por sessão vindos do desktop
    const unsubModels = conn.onEvent('session:model-change', (event) => {
      const msg = event as { overrides?: Record<string, { providerId: string; modelId: string }> }
      if (msg?.overrides) {
        useSessionModelPrefs.getState().applySync(msg.overrides)
      }
    })

    // rotinas:event → rotinas store (criar/editar/excluir/execução pelo scheduler)
    const unsubRotinas = conn.onEvent('rotinas:event', (event) => {
      const msg = event as RotinaEventMessage
      if (msg?.event) {
        useRotinasStore.getState().aplicarEvento(msg.event)
      }
    })

    // esteira:event → esteira store (tasks, fases, fila, progresso ao vivo)
    const unsubEsteira = conn.onEvent('esteira:event', (event) => {
      const msg = event as EsteiraEventMessage
      if (msg?.event) {
        useEsteiraStore.getState().aplicarEvento(msg.event)
      }
    })

    return () => {
      unsubChat()
      unsubModels()
      unsubRotinas()
      unsubEsteira()
    }
  }, [])
}
