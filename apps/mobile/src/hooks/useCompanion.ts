import { useEffect } from 'react'
import type {
  AppPreferences,
  SessionModelChangeEvent,
  ChatEventMessage,
  EsteiraEventMessage,
  RotinaEventMessage,
  SessionModeOverrides,
  WorkerConfigSnapshot,
} from '@orbit/shared'
import { useConnectionStore } from '../stores/connection-store'
import { useMessageQueueStore } from '../stores/message-queue-store'
import { useRecentConnectionsStore } from '~/stores/recent-connections-store'
import { useSessionStore } from '../stores/session-store'
import { useSettingsStore } from '../stores/settings-store'
import { useSessionModelPrefs } from '~/stores/session-model-prefs'
import { applyRemoteModes, fetchSessionModes } from '~/stores/session-modes-sync'
import { applyAppPreferences, hydrateAppPreferences } from '~/stores/prefs-sync'
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
        // O chat aberto pode ter ganho cards (pergunta, permissao, plano)
        // enquanto o socket estava fora: os eventos ao vivo passaram sem
        // ninguem ouvindo, entao o estado da sessao e rebuscado no desktop.
        const activeId = useSessionStore.getState().activeSessionId
        if (activeId) void useSessionStore.getState().fetchMessages(activeId)
        // Quem ainda esta rodando no desktop — sem isto, conectar no meio de
        // uma execucao mostra a conversa parada (e reconectar depois dela
        // terminar deixa o spinner preso).
        void useSessionStore.getState().fetchRunningSessions()
        void useSessionStore.getState().fetchFolders()
        void useSettingsStore.getState().fetchSelectedModel()
        void useSettingsStore.getState().fetchPreferences()
        void useSettingsStore.getState().fetchCatalog()
        void useSettingsStore.getState().fetchConnectedProviders()
        // Overrides de modelo por sessão (snapshot do renderer do desktop)
        void useSessionModelPrefs.getState().hydrate()
        // Modos ativos por chat (mesmo caminho: snapshot do renderer)
        void fetchSessionModes()
        // Config de subagentes/orquestração e visão (global, mora no desktop)
        void useSettingsStore.getState().fetchWorkerConfig()
        // Preferências do desktop mandam: na conexão o celular adota as de lá
        // (defaults de modo, permissão, pastas automáticas).
        void hydrateAppPreferences()
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
      const msg = event as Partial<SessionModelChangeEvent>
      if (msg?.overrides) {
        useSessionModelPrefs.getState().applySync(msg.overrides)
      }
    })

    // session:mode-change → modos ativos por chat mudados no desktop
    const unsubModes = conn.onEvent('session:mode-change', (event) => {
      const msg = event as { overrides?: SessionModeOverrides }
      if (msg?.overrides) applyRemoteModes(msg.overrides, true)
    })

    // worker-config:change → modelo dos workers / modelo de visão do desktop
    const unsubWorkerConfig = conn.onEvent('worker-config:change', (event) => {
      const msg = event as { config?: WorkerConfigSnapshot }
      if (msg?.config) useSettingsStore.getState().applyWorkerConfigSync(msg.config)
    })

    // prefs:change → preferências do app (defaults de modo, permissão, pastas
    // automáticas) mudadas no desktop ou em outro aparelho pareado
    const unsubPrefs = conn.onEvent('prefs:change', (event) => {
      const msg = event as { prefs?: AppPreferences }
      if (msg?.prefs) applyAppPreferences(msg.prefs)
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
      unsubModes()
      unsubWorkerConfig()
      unsubPrefs()
      unsubRotinas()
      unsubEsteira()
    }
  }, [])
}
