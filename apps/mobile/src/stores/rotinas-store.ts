import { create } from 'zustand'
import type {
  NovaRotinaInput,
  ResultadoGeracao,
  Rotina,
  RotinaEvent,
  RotinaModelo,
  RotinaRun,
} from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { useSessionStore } from './session-store'

/**
 * Estado das rotinas no app (espelho do rotinas-store do desktop, mas via WS).
 *
 * O main do desktop é o dono da verdade: toda mutação vai por uma request
 * `rotinas:*` e volta como evento `rotinas:event` — inclusive as que o
 * scheduler dispara sozinho (execução começando, terminando, ultimaExecucao
 * avançando). Sem atualização otimista de execução.
 *
 * As EXECUÇÕES exibidas no detalhe são derivadas das sessões
 * (`sessions.filter(s => s.routineId === id)`): `runs` guarda só as métricas,
 * chaveadas por sessionId — apagar o chat na sidebar faz o run sumir da lista.
 */

interface RotinasState {
  rotinas: Rotina[]
  runs: RotinaRun[]
  loading: boolean
  carregado: boolean

  /** Busca o snapshot completo (rotinas + runs) via WS. */
  fetch: () => Promise<void>
  aplicarEvento: (evento: RotinaEvent) => void

  gerar: (
    descricao: string,
    modelo: RotinaModelo,
    pastas: string[],
    idioma?: string,
    modo?: 'chat' | 'code',
    visionDisponivel?: boolean,
  ) => Promise<ResultadoGeracao>
  criar: (input: NovaRotinaInput) => Promise<Rotina>
  atualizar: (id: string, patch: Partial<Rotina>) => Promise<void>
  /** Exclui a rotina + chats das execuções + métricas. */
  remover: (id: string) => Promise<void>
  executarAgora: (id: string) => Promise<string | null>
  /** Descarta métricas de execuções cujo chat não existe mais. */
  podar: (sessionIdsVivos: string[]) => Promise<void>

  emExecucao: (rotinaId: string) => boolean
}

export const useRotinasStore = create<RotinasState>((set, get) => ({
  rotinas: [],
  runs: [],
  loading: false,
  carregado: false,

  fetch: async () => {
    const { wsClient } = useConnectionStore.getState()
    set({ loading: true })
    try {
      const res = await wsClient.send({ type: 'rotinas:list' })
      if (res.ok && res.data) {
        const dados = res.data as { rotinas: Rotina[]; runs: RotinaRun[] }
        set({ rotinas: dados.rotinas, runs: dados.runs, carregado: true })
      }
    } catch {
      // WS indisponível — mantém o estado atual
    } finally {
      set({ loading: false })
    }
  },

  aplicarEvento: (evento) => {
    switch (evento.type) {
      case 'rotinas':
        set({ rotinas: evento.rotinas })
        break
      case 'rotina':
        set((state) => {
          const existe = state.rotinas.some((r) => r.id === evento.rotina.id)
          return {
            rotinas: existe
              ? state.rotinas.map((r) => (r.id === evento.rotina.id ? evento.rotina : r))
              : [...state.rotinas, evento.rotina],
          }
        })
        break
      case 'rotina-removida':
        set((state) => ({
          rotinas: state.rotinas.filter((r) => r.id !== evento.id),
          runs: state.runs.filter((r) => r.rotinaId !== evento.id),
        }))
        break
      case 'run':
        set((state) => {
          const existe = state.runs.some((r) => r.sessionId === evento.run.sessionId)
          return {
            runs: existe
              ? state.runs.map((r) => (r.sessionId === evento.run.sessionId ? evento.run : r))
              : [...state.runs, evento.run],
          }
        })
        break
    }
  },

  gerar: (descricao, modelo, pastas, idioma, modo, visionDisponivel) => {
    const { wsClient } = useConnectionStore.getState()
    return wsClient
      .send({ type: 'rotinas:generate', descricao, modelo, pastas, idioma, modo, visionDisponivel })
      .then((res) => (res.ok && res.data ? (res.data as ResultadoGeracao) : { ok: false, erro: res.error ?? 'Falha ao gerar' }))
  },

  criar: async (input) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'rotinas:create', input })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Falha ao criar a rotina')
    const rotina = res.data as Rotina
    set((state) => ({
      rotinas: state.rotinas.some((r) => r.id === rotina.id) ? state.rotinas : [...state.rotinas, rotina],
      carregado: true,
    }))
    return rotina
  },

  atualizar: async (id, patch) => {
    const { wsClient } = useConnectionStore.getState()
    await wsClient.send({ type: 'rotinas:update', id, patch })
  },

  remover: async (id) => {
    // Excluir a rotina apaga também os chats das execuções. O cascade real
    // (abortar stream, storage) é o deleteSession do session-store — o main só
    // cuida do registro da rotina e das métricas.
    const sessoes = useSessionStore
      .getState()
      .sessions.filter((s) => s.routineId === id)
      .map((s) => s.id)
    for (const sessionId of sessoes) {
      await useSessionStore.getState().deleteSession(sessionId)
    }
    const { wsClient } = useConnectionStore.getState()
    await wsClient.send({ type: 'rotinas:delete', id })
    set((state) => ({
      rotinas: state.rotinas.filter((r) => r.id !== id),
      runs: state.runs.filter((r) => r.rotinaId !== id),
    }))
  },

  executarAgora: async (id) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'rotinas:run', id })
    if (!res.ok) return null
    return (res.data as string | null) ?? null
  },

  podar: async (sessionIdsVivos) => {
    const vivos = new Set(sessionIdsVivos)
    const orfaos = get().runs.filter((r) => r.status !== 'rodando' && !vivos.has(r.sessionId))
    if (orfaos.length === 0) return
    const { wsClient } = useConnectionStore.getState()
    await wsClient.send({ type: 'rotinas:prune-runs', sessionIds: sessionIdsVivos })
    set((state) => ({
      runs: state.runs.filter((r) => r.status === 'rodando' || vivos.has(r.sessionId)),
    }))
  },

  emExecucao: (rotinaId) => get().runs.some((r) => r.rotinaId === rotinaId && r.status === 'rodando'),
}))
