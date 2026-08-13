import { create } from "zustand"
import type { Esteira, EsteiraEvent, FaseTemplate, Projeto, Task } from "@shared/esteira"
import { esteiraApi, type NovaEsteiraInput } from "@/src/lib/ipc"

/**
 * Estado do modo esteira no renderer.
 *
 * O main é o dono da verdade: toda mutação vai por IPC e volta como
 * `esteira:event` — inclusive as que o próprio engine dispara sozinho (fase
 * concluída, task pausada por erro, fila avançando). Por isso o store não faz
 * atualização otimista de execução: ele reflete o que o main confirmou, senão
 * o board mostraria uma fase que não terminou.
 */

interface EsteiraState {
  projetos: Projeto[]
  esteiras: Esteira[]
  tasksPorEsteira: Record<string, Task[]>
  templates: FaseTemplate[]
  /** Filas automáticas ligadas (id da esteira) */
  filasLigadas: Record<string, boolean>
  /** Texto ao vivo da fase em execução, por task */
  progresso: Record<string, string>
  carregado: boolean
  /** Esteira aberta no board (null = lista). O header do app lê daqui para
   *  só mostrar pasta/branch depois que uma esteira foi escolhida. */
  abertaId: string | null
  setAberta: (id: string | null) => void

  carregar: () => Promise<void>
  aplicarEvento: (evento: EsteiraEvent) => void

  criarProjeto: (nome: string, pastas: string[]) => Promise<Projeto>
  atualizarProjeto: (id: string, patch: Partial<Pick<Projeto, "nome" | "pastas">>) => Promise<void>
  removerProjeto: (id: string) => Promise<void>

  salvarTemplate: (template: FaseTemplate) => Promise<void>
  removerTemplate: (id: string) => Promise<void>

  criarEsteira: (input: NovaEsteiraInput) => Promise<Esteira>
  atualizarEsteira: (id: string, patch: Partial<Esteira>) => Promise<void>
  removerEsteira: (id: string) => Promise<void>

  criarTask: (esteiraId: string, titulo: string, descricao: string, dependeDe?: string[]) => Promise<Task>
  atualizarTask: (esteiraId: string, taskId: string, patch: Partial<Task>) => Promise<void>
  removerTask: (esteiraId: string, taskId: string) => Promise<void>
  iniciarTask: (esteiraId: string, taskId: string, fase?: number) => Promise<void>
  pausarTask: (esteiraId: string, taskId: string) => Promise<void>
  retomarTask: (esteiraId: string, taskId: string) => Promise<void>
  alternarFila: (esteiraId: string, ligar: boolean) => Promise<void>

  tasksDe: (esteiraId: string) => Task[]
  esteirasDe: (projetoId: string) => Esteira[]
}

/**
 * Array vazio ESTÁVEL para os seletores. `s.tasksPorEsteira[id] ?? []` cria um
 * array novo a cada chamada do seletor: o zustand compara o snapshot por
 * identidade, conclui que mudou, re-renderiza, chama o seletor de novo... e o
 * React derruba a árvore com "Maximum update depth exceeded". Aparecia ao
 * criar a esteira, que é exatamente quando ainda não existe a chave.
 */
export const SEM_TASKS: Task[] = []

export const useEsteiraStore = create<EsteiraState>((set, get) => ({
  projetos: [],
  esteiras: [],
  tasksPorEsteira: {},
  templates: [],
  filasLigadas: {},
  progresso: {},
  carregado: false,
  abertaId: null,
  setAberta: (id) => set({ abertaId: id }),

  carregar: async () => {
    const [dados, templates] = await Promise.all([esteiraApi.carregar(), esteiraApi.templates()])
    set({
      projetos: dados.projetos,
      esteiras: dados.esteiras,
      tasksPorEsteira: dados.tasksPorEsteira,
      templates,
      carregado: true,
    })
  },

  aplicarEvento: (evento) => {
    switch (evento.type) {
      case "projetos":
        set({ projetos: evento.projetos })
        break
      case "esteira":
        set((state) => {
          const existe = state.esteiras.some((e) => e.id === evento.esteira.id)
          return {
            esteiras: existe
              ? state.esteiras.map((e) => (e.id === evento.esteira.id ? evento.esteira : e))
              : [...state.esteiras, evento.esteira],
          }
        })
        break
      case "task":
        set((state) => {
          const atuais = state.tasksPorEsteira[evento.esteiraId] ?? []
          const existe = atuais.some((t) => t.id === evento.task.id)
          return {
            tasksPorEsteira: {
              ...state.tasksPorEsteira,
              [evento.esteiraId]: existe
                ? atuais.map((t) => (t.id === evento.task.id ? evento.task : t))
                : [...atuais, evento.task],
            },
          }
        })
        break
      case "tasks":
        set((state) => ({
          tasksPorEsteira: { ...state.tasksPorEsteira, [evento.esteiraId]: evento.tasks },
        }))
        break
      case "fase-progresso":
        set((state) => ({
          progresso: {
            // Só o final interessa no card — guardar o texto inteiro da fase
            // encheria a memória do renderer sem nada aparecer na tela.
            [evento.taskId]: (state.progresso[evento.taskId] ?? "").concat(evento.texto).slice(-600),
            ...Object.fromEntries(Object.entries(state.progresso).filter(([id]) => id !== evento.taskId)),
          },
        }))
        break
    }
  },

  criarProjeto: async (nome, pastas) => {
    const projeto = await esteiraApi.criarProjeto(nome, pastas)
    set((state) => ({ projetos: [...state.projetos, projeto] }))
    return projeto
  },
  atualizarProjeto: async (id, patch) => {
    await esteiraApi.atualizarProjeto(id, patch)
  },
  removerProjeto: async (id) => {
    await esteiraApi.removerProjeto(id)
    set((state) => ({
      esteiras: state.esteiras.filter((e) => e.projetoId !== id),
      projetos: state.projetos.filter((p) => p.id !== id),
    }))
  },

  salvarTemplate: async (template) => {
    set({ templates: await esteiraApi.salvarTemplate(template) })
  },
  removerTemplate: async (id) => {
    set({ templates: await esteiraApi.removerTemplate(id) })
  },

  criarEsteira: async (input) => {
    const esteira = await esteiraApi.criar(input)
    set((state) => ({ esteiras: [...state.esteiras, esteira] }))
    return esteira
  },
  atualizarEsteira: async (id, patch) => {
    await esteiraApi.atualizar(id, patch)
  },
  removerEsteira: async (id) => {
    await esteiraApi.remover(id)
    set((state) => {
      const resto = Object.fromEntries(Object.entries(state.tasksPorEsteira).filter(([key]) => key !== id))
      return { esteiras: state.esteiras.filter((e) => e.id !== id), tasksPorEsteira: resto }
    })
  },

  criarTask: (esteiraId, titulo, descricao, dependeDe) =>
    esteiraApi.criarTask({ esteiraId, titulo, descricao, dependeDe }),
  atualizarTask: async (esteiraId, taskId, patch) => {
    await esteiraApi.atualizarTask(esteiraId, taskId, patch)
  },
  removerTask: async (esteiraId, taskId) => {
    await esteiraApi.removerTask(esteiraId, taskId)
  },
  iniciarTask: async (esteiraId, taskId, fase) => {
    await esteiraApi.iniciarTask(esteiraId, taskId, fase)
  },
  pausarTask: async (esteiraId, taskId) => {
    await esteiraApi.pausarTask(esteiraId, taskId)
  },
  retomarTask: async (esteiraId, taskId) => {
    await esteiraApi.retomarTask(esteiraId, taskId)
  },
  alternarFila: async (esteiraId, ligar) => {
    const estado = await esteiraApi.ligarFila(esteiraId, ligar)
    set((state) => ({ filasLigadas: { ...state.filasLigadas, [esteiraId]: estado } }))
  },

  tasksDe: (esteiraId) => get().tasksPorEsteira[esteiraId] ?? SEM_TASKS,
  esteirasDe: (projetoId) => get().esteiras.filter((e) => e.projetoId === projetoId),
}))
