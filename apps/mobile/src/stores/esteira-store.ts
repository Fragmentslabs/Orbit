import { create } from 'zustand'
import type {
  Esteira,
  EsteiraEvent,
  FaseTemplate,
  NovaEsteiraInput,
  Projeto,
  Task,
} from '@orbit/shared'
import { useConnectionStore } from './connection-store'

/**
 * Estado da esteira no app (espelho do esteira-store do desktop, mas via WS).
 *
 * O main do desktop é o dono da verdade: toda mutação vai por uma request
 * `esteira:*` e volta como evento `esteira:event` — inclusive as que o engine
 * dispara sozinho (fase concluída, task pausada por erro, fila avançando,
 * progresso/pensamento/tools ao vivo). Por isso não há atualização otimista
 * de execução: a tela reflete o que o main confirmou.
 *
 * Remoções não geram evento (mesma limitação do desktop multi-janela): o store
 * remove localmente após a request confirmar.
 */

interface AtividadeTool {
  toolCallId: string
  tool: string
  estado: 'rodando' | 'concluida' | 'erro'
  resumo: string
  detalhe?: string
}

export interface AtividadeTask {
  faseIndice: number
  pensando: string
  tools: AtividadeTool[]
}

/**
 * Array vazio ESTÁVEL para os seletores — `s.tasksPorEsteira[id] ?? []` cria
 * um array novo por chamada e derruba o zustand com re-render infinito
 * ("Maximum update depth exceeded", mesma correção do desktop).
 */
export const SEM_TASKS: Task[] = []

interface EsteiraState {
  projetos: Projeto[]
  esteiras: Esteira[]
  tasksPorEsteira: Record<string, Task[]>
  templates: FaseTemplate[]
  /** Filas automáticas ligadas (id da esteira) */
  filasLigadas: Record<string, boolean>
  /** Texto ao vivo da fase em execução, por task */
  progresso: Record<string, string>
  /** Execução ao vivo por task: pensamento (reasoning) + ferramentas */
  atividade: Record<string, AtividadeTask>
  loading: boolean
  carregado: boolean
  /** Mensagem da última falha de carregamento (desconexão, erro do desktop...). */
  erro: string | null

  /** Busca o snapshot completo (projetos + esteiras + tasks + templates). */
  fetch: () => Promise<void>
  aplicarEvento: (evento: EsteiraEvent) => void

  criarProjeto: (nome: string, pastas: string[]) => Promise<Projeto>
  atualizarProjeto: (id: string, patch: Partial<Pick<Projeto, 'nome' | 'pastas'>>) => Promise<void>

  salvarTemplate: (template: FaseTemplate) => Promise<void>

  criarEsteira: (input: NovaEsteiraInput) => Promise<Esteira>
  atualizarEsteira: (id: string, patch: Partial<Esteira>) => Promise<void>
  removerEsteira: (id: string) => Promise<void>

  criarTask: (esteiraId: string, titulo: string, descricao: string, dependeDe?: string[]) => Promise<Task>
  atualizarTask: (
    esteiraId: string,
    taskId: string,
    patch: Partial<Pick<Task, 'titulo' | 'descricao' | 'dependeDe' | 'anotacoes'>>,
  ) => Promise<void>
  removerTask: (esteiraId: string, taskId: string) => Promise<void>
  iniciarTask: (esteiraId: string, taskId: string, fase?: number) => Promise<void>
  pausarTask: (esteiraId: string, taskId: string) => Promise<void>
  retomarTask: (esteiraId: string, taskId: string) => Promise<void>
  alternarFila: (esteiraId: string, ligar: boolean) => Promise<void>

  tasksDe: (esteiraId: string) => Task[]
}

export const useEsteiraStore = create<EsteiraState>((set, get) => ({
  projetos: [],
  esteiras: [],
  tasksPorEsteira: {},
  templates: [],
  filasLigadas: {},
  progresso: {},
  atividade: {},
  loading: false,
  carregado: false,
  erro: null,

  fetch: async () => {
    const { wsClient, connection } = useConnectionStore.getState()
    set({ loading: true, erro: null })
    try {
      // Sem conexão o send() ficaria enfileirado para sempre — falha rápido
      // com uma mensagem que a tela consegue mostrar (com botão de retry).
      if (connection.status !== 'connected') {
        const falha = 'Conecte-se ao Orbit Desktop para carregar as esteiras'
        set({ erro: falha })
        console.warn('[esteira] fetch falhou:', falha)
        return
      }
      const res = await wsClient.send({ type: 'esteira:list' })
      if (res.ok && res.data) {
        const dados = res.data as {
          projetos: Projeto[]
          esteiras: Esteira[]
          tasksPorEsteira: Record<string, Task[]>
          templates: FaseTemplate[]
        }
        set({
          projetos: dados.projetos,
          esteiras: dados.esteiras,
          tasksPorEsteira: dados.tasksPorEsteira,
          templates: dados.templates,
          carregado: true,
          erro: null,
        })
      } else {
        // Ex.: desktop com build antigo responde "Tipo de request desconhecido".
        const falha = res.error ?? 'Falha ao carregar as esteiras'
        set({ erro: falha })
        console.warn('[esteira] fetch falhou:', falha)
      }
    } catch (err) {
      const falha = err instanceof Error ? err.message : String(err)
      set({ erro: falha })
      console.warn('[esteira] fetch falhou:', falha)
    } finally {
      set({ loading: false })
    }
  },

  aplicarEvento: (evento) => {
    switch (evento.type) {
      case 'projetos':
        set({ projetos: evento.projetos })
        break
      case 'esteira':
        set((state) => {
          const existe = state.esteiras.some((e) => e.id === evento.esteira.id)
          return {
            esteiras: existe
              ? state.esteiras.map((e) => (e.id === evento.esteira.id ? evento.esteira : e))
              : [...state.esteiras, evento.esteira],
          }
        })
        break
      case 'task':
        set((state) => {
          const atuais = state.tasksPorEsteira[evento.esteiraId] ?? []
          const existe = atuais.some((t) => t.id === evento.task.id)
          // Task parou de rodar (concluída/pausada): a atividade ao vivo
          // perde o sentido — o detalhe volta a mostrar as anotações.
          const atividade =
            evento.task.status !== 'em_progresso' && state.atividade[evento.task.id]
              ? Object.fromEntries(Object.entries(state.atividade).filter(([id]) => id !== evento.task.id))
              : state.atividade
          return {
            tasksPorEsteira: {
              ...state.tasksPorEsteira,
              [evento.esteiraId]: existe
                ? atuais.map((t) => (t.id === evento.task.id ? evento.task : t))
                : [...atuais, evento.task],
            },
            atividade,
          }
        })
        break
      case 'tasks':
        set((state) => ({
          tasksPorEsteira: { ...state.tasksPorEsteira, [evento.esteiraId]: evento.tasks },
        }))
        break
      case 'fase-progresso':
        set((state) => ({
          progresso: {
            // Só o final interessa no card — guardar o texto inteiro da fase
            // encheria a memória do app sem nada aparecer na tela.
            [evento.taskId]: (state.progresso[evento.taskId] ?? '').concat(evento.texto).slice(-600),
            ...Object.fromEntries(Object.entries(state.progresso).filter(([id]) => id !== evento.taskId)),
          },
        }))
        break
      case 'fase-pensando':
        set((state) => {
          const atual = state.atividade[evento.taskId]
          const base =
            atual && atual.faseIndice === evento.faseIndice
              ? atual
              : { faseIndice: evento.faseIndice, pensando: '', tools: [] }
          return {
            atividade: {
              ...state.atividade,
              [evento.taskId]: {
                ...base,
                pensando: (base.pensando + evento.texto).slice(-1200),
              },
            },
          }
        })
        break
      case 'fase-tool':
        set((state) => {
          const atual = state.atividade[evento.taskId]
          const base =
            atual && atual.faseIndice === evento.faseIndice
              ? atual
              : { faseIndice: evento.faseIndice, pensando: '', tools: [] }
          const tools = [...base.tools]
          const indice = tools.findIndex((t) => t.toolCallId === evento.toolCallId)
          const nova: AtividadeTool = {
            toolCallId: evento.toolCallId,
            tool: evento.tool,
            estado: evento.estado,
            resumo: evento.resumo,
            detalhe: evento.detalhe,
          }
          if (indice >= 0) tools[indice] = nova
          else tools.push(nova)
          return {
            atividade: {
              ...state.atividade,
              [evento.taskId]: { ...base, tools: tools.slice(-40) },
            },
          }
        })
        break
    }
  },

  criarProjeto: async (nome, pastas) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:create-projeto', nome, pastas })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Falha ao criar o projeto')
    const projeto = res.data as Projeto
    set((state) => ({ projetos: [...state.projetos, projeto] }))
    return projeto
  },

  atualizarProjeto: async (id, patch) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:update-projeto', id, patch })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao atualizar o projeto')
  },

  salvarTemplate: async (template) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:save-template', template })
    if (res.ok && res.data) set({ templates: res.data as FaseTemplate[] })
  },

  criarEsteira: async (input) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:create', input })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Falha ao criar a esteira')
    const esteira = res.data as Esteira
    set((state) => ({
      esteiras: state.esteiras.some((e) => e.id === esteira.id) ? state.esteiras : [...state.esteiras, esteira],
      carregado: true,
    }))
    return esteira
  },

  atualizarEsteira: async (id, patch) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:update', id, patch })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao atualizar a esteira')
  },

  removerEsteira: async (id) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:delete', id })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao excluir a esteira')
    set((state) => {
      const resto = Object.fromEntries(Object.entries(state.tasksPorEsteira).filter(([key]) => key !== id))
      return { esteiras: state.esteiras.filter((e) => e.id !== id), tasksPorEsteira: resto }
    })
  },

  criarTask: async (esteiraId, titulo, descricao, dependeDe) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({
      type: 'esteira:create-task',
      input: { esteiraId, titulo, descricao, dependeDe },
    })
    if (!res.ok || !res.data) throw new Error(res.error ?? 'Falha ao criar a task')
    return res.data as Task
  },

  atualizarTask: async (esteiraId, taskId, patch) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:update-task', esteiraId, taskId, patch })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao atualizar a task')
  },

  removerTask: async (esteiraId, taskId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:delete-task', esteiraId, taskId })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao excluir a task')
  },

  iniciarTask: async (esteiraId, taskId, fase) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:start-task', esteiraId, taskId, fase })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao iniciar a task')
  },

  pausarTask: async (esteiraId, taskId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:pause-task', esteiraId, taskId })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao pausar a task')
  },

  retomarTask: async (esteiraId, taskId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:resume-task', esteiraId, taskId })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao retomar a task')
  },

  alternarFila: async (esteiraId, ligar) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'esteira:toggle-fila', esteiraId, ligar })
    if (!res.ok) throw new Error(res.error ?? 'Falha ao alternar a fila')
    set((state) => ({ filasLigadas: { ...state.filasLigadas, [esteiraId]: res.data === true } }))
  },

  tasksDe: (esteiraId) => get().tasksPorEsteira[esteiraId] ?? SEM_TASKS,
}))
