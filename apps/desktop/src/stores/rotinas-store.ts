import { create } from "zustand"
import type {
  NovaRotinaInput,
  ResultadoGeracao,
  Rotina,
  RotinaEvent,
  RotinaModelo,
  RotinaRun,
} from "@shared/rotinas"
import { ROTINAS_PADRAO } from "@shared/rotinas-padrao"
import { rotinasApi } from "@/src/lib/ipc"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Estado das rotinas no renderer.
 *
 * O main é o dono da verdade: toda mutação vai por IPC e volta como
 * `rotinas:event` — inclusive as que o scheduler dispara sozinho (execução
 * começando, terminando, `ultimaExecucao` avançando). Igual ao esteira-store,
 * não há atualização otimista de execução.
 *
 * As EXECUÇÕES exibidas no painel são derivadas das sessões
 * (`sessions.filter(s => s.routineId === id)`): `runs` guarda só as métricas,
 * chaveadas por sessionId. Uma fonte de verdade só — apagar o chat na sidebar
 * faz o run sumir da lista sem nenhum estado "excluído" pendurado.
 */

interface RotinasState {
  rotinas: Rotina[]
  runs: RotinaRun[]
  carregado: boolean
  /** Rotina aberta no painel de detalhe (null = lista) */
  abertaId: string | null
  setAberta: (id: string | null) => void

  carregar: () => Promise<void>
  aplicarEvento: (evento: RotinaEvent) => void

  gerar: (
    descricao: string,
    modelo: RotinaModelo,
    pastas: string[],
    idioma?: string,
    modo?: "chat" | "code",
    visionDisponivel?: boolean,
  ) => Promise<ResultadoGeracao>
  criar: (input: NovaRotinaInput) => Promise<Rotina>
  atualizar: (id: string, patch: Partial<Rotina>) => Promise<void>
  remover: (id: string) => Promise<void>
  executarAgora: (id: string) => Promise<string | null>
  /** Descarta métricas de execuções cujo chat não existe mais. */
  podar: (sessionIdsVivos: string[]) => Promise<void>

  runsDe: (rotinaId: string) => RotinaRun[]
  runDaSessao: (sessionId: string) => RotinaRun | undefined
  emExecucao: (rotinaId: string) => boolean
}

/** Array vazio ESTÁVEL: `?? []` num seletor zustand vira loop de render. */
export const SEM_RUNS: RotinaRun[] = []

/** Presets já semeados — por id, para o usuário poder apagar sem que voltem. */
const SEMEADAS_KEY = "orbit-rotinas-padrao-semeadas"

function jaSemeadas(): string[] {
  try {
    const bruto = localStorage.getItem(SEMEADAS_KEY)
    return bruto ? (JSON.parse(bruto) as string[]) : []
  } catch {
    return []
  }
}

/**
 * Cria as rotinas de manutenção que acompanham o produto, DESATIVADAS.
 *
 * Só roda quando já existe um modelo selecionado: `Rotina.modelo` é
 * obrigatório, e semear com um modelo inventado deixaria uma rotina que
 * quebra no primeiro uso. Sem modelo, tenta de novo no próximo carregamento.
 *
 * O registro do que já foi semeado é por id e fica no localStorage: quem
 * apagar um preset não o vê renascer no próximo boot.
 */
async function semearRotinasPadrao(): Promise<void> {
  const feitas = new Set(jaSemeadas())
  const pendentes = ROTINAS_PADRAO.filter((r) => !feitas.has(r.id))
  if (pendentes.length === 0) return

  const modelo = useProviderStore.getState().selectedModel
  if (!modelo) return

  for (const preset of pendentes) {
    try {
      await useRotinasStore.getState().criar({
        titulo: preset.titulo,
        prompt: preset.prompt,
        agenda: preset.agenda,
        modelo: { providerId: modelo.providerId, modelId: modelo.modelId },
        modos: preset.modos,
        mode: preset.mode,
        // Ambos os presets são modo chat e não leem arquivos — sem pastas.
        pastas: [],
        ativa: false,
      })
      feitas.add(preset.id)
    } catch (err) {
      // Falhar a semeadura nunca pode derrubar a tela de rotinas.
      console.error("[rotinas] preset não pôde ser criado:", preset.id, err)
    }
  }
  localStorage.setItem(SEMEADAS_KEY, JSON.stringify([...feitas]))
}

export const useRotinasStore = create<RotinasState>((set, get) => ({
  rotinas: [],
  runs: [],
  carregado: false,
  abertaId: null,
  setAberta: (id) => set({ abertaId: id }),

  carregar: async () => {
    const dados = await rotinasApi.carregar()
    set({ rotinas: dados.rotinas, runs: dados.runs, carregado: true })
    await semearRotinasPadrao()
  },

  aplicarEvento: (evento) => {
    switch (evento.type) {
      case "rotinas":
        set({ rotinas: evento.rotinas })
        break
      case "rotina":
        set((state) => {
          const existe = state.rotinas.some((r) => r.id === evento.rotina.id)
          return {
            rotinas: existe
              ? state.rotinas.map((r) => (r.id === evento.rotina.id ? evento.rotina : r))
              : [...state.rotinas, evento.rotina],
          }
        })
        break
      case "rotina-removida":
        set((state) => ({
          rotinas: state.rotinas.filter((r) => r.id !== evento.id),
          runs: state.runs.filter((r) => r.rotinaId !== evento.id),
          abertaId: state.abertaId === evento.id ? null : state.abertaId,
        }))
        break
      case "run":
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

  gerar: (descricao, modelo, pastas, idioma, modo, visionDisponivel) =>
    rotinasApi.gerar(descricao, modelo, pastas, idioma, modo, visionDisponivel),

  criar: async (input) => {
    const rotina = await rotinasApi.criar(input)
    set((state) => ({
      rotinas: state.rotinas.some((r) => r.id === rotina.id)
        ? state.rotinas
        : [...state.rotinas, rotina],
    }))
    return rotina
  },

  atualizar: async (id, patch) => {
    await rotinasApi.atualizar(id, patch)
  },

  remover: async (id) => {
    // Excluir a rotina apaga também os chats das execuções. O cascade real
    // (abortar stream, storage, prefs, browser do painel) é o deleteSession do
    // session-store — o main só cuida do registro da rotina e das métricas.
    const sessoes = useSessionStore
      .getState()
      .sessions.filter((s) => s.routineId === id)
      .map((s) => s.id)
    for (const sessionId of sessoes) {
      await useSessionStore.getState().deleteSession(sessionId)
    }
    await rotinasApi.remover(id)
    set((state) => ({
      rotinas: state.rotinas.filter((r) => r.id !== id),
      runs: state.runs.filter((r) => r.rotinaId !== id),
      abertaId: state.abertaId === id ? null : state.abertaId,
    }))
  },

  executarAgora: (id) => rotinasApi.executarAgora(id),

  podar: async (sessionIdsVivos) => {
    const vivos = new Set(sessionIdsVivos)
    const orfaos = get().runs.filter((r) => r.status !== "rodando" && !vivos.has(r.sessionId))
    if (orfaos.length === 0) return
    await rotinasApi.podarRuns(sessionIdsVivos)
    set((state) => ({
      runs: state.runs.filter((r) => r.status === "rodando" || vivos.has(r.sessionId)),
    }))
  },

  runsDe: (rotinaId) => get().runs.filter((r) => r.rotinaId === rotinaId),
  runDaSessao: (sessionId) => get().runs.find((r) => r.sessionId === sessionId),
  emExecucao: (rotinaId) => get().runs.some((r) => r.rotinaId === rotinaId && r.status === "rodando"),
}))
