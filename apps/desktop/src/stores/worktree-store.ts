import { create } from "zustand"
import type { CriarWorktreeResultado, ListaWorktrees } from "@shared/worktrees"
import { worktreeApi } from "@/src/lib/ipc"

/**
 * Worktrees do repositório de cada pasta (seletor do header) e o mapa
 * "pasta dentro de um worktree → mesma pasta no repositório principal".
 *
 * O mapa existe porque o resto do app identifica o projeto pelo caminho: sem
 * ele, um chat aberto num worktree cairia numa pasta nova da sidebar, com o
 * nome do worktree, em vez de ficar junto dos outros chats do projeto.
 */
interface WorktreeState {
  /** Por pasta consultada (a pasta principal do chat); null = não é repositório git */
  porPasta: Record<string, ListaWorktrees | null>
  carregando: Record<string, boolean>
  /** pasta num worktree → pasta equivalente no principal */
  principalDe: Record<string, string>
  carregar: (pasta: string) => Promise<ListaWorktrees | null>
  criar: (pasta: string, nome: string, base?: string) => Promise<CriarWorktreeResultado>
  remover: (pasta: string, caminho: string, apagarBranch?: boolean) => Promise<void>
  /** Resolve (e guarda) o principal de uma pasta que chegou de fora — ex.: troca feita pelo agente */
  resolverPrincipal: (pasta: string) => Promise<string>
}

const consultas = new Map<string, Promise<ListaWorktrees | null>>()

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  porPasta: {},
  carregando: {},
  principalDe: {},

  carregar: (pasta) => {
    // O chip do header e o menu compacto montam juntos e pedem a mesma lista:
    // uma consulta em andamento é compartilhada (cada uma roda git status em
    // todos os worktrees).
    const emAndamento = consultas.get(pasta)
    if (emAndamento) return emAndamento
    const consulta = carregarAgora(pasta).finally(() => consultas.delete(pasta))
    consultas.set(pasta, consulta)
    return consulta
  },

  criar: async (pasta, nome, base) => {
    const criado = await worktreeApi.criar(pasta, nome, base)
    await get().carregar(pasta)
    // A lista acima foi consultada pela pasta antiga; a nova também precisa
    // do mapa (é para ela que o chat vai).
    const principal = await worktreeApi.principal(criado.pasta)
    set((s) => ({ principalDe: { ...s.principalDe, [criado.pasta]: principal } }))
    return criado
  },

  remover: async (pasta, caminho, apagarBranch) => {
    await worktreeApi.remover(pasta, caminho, apagarBranch)
    await get().carregar(pasta)
  },

  resolverPrincipal: async (pasta) => {
    const conhecido = get().principalDe[pasta]
    if (conhecido) return conhecido
    const principal = await worktreeApi.principal(pasta)
    if (principal !== pasta) set((s) => ({ principalDe: { ...s.principalDe, [pasta]: principal } }))
    return principal
  },
}))

/** Pasta no repositório principal, quando já conhecida (síncrono, para a sidebar). */
export function principalConhecido(pasta: string): string {
  return useWorktreeStore.getState().principalDe[pasta] ?? pasta
}

/** Consulta de fato: lista os worktrees e atualiza o mapa worktree → principal. */
async function carregarAgora(pasta: string): Promise<ListaWorktrees | null> {
  const set = useWorktreeStore.setState
  set((s) => ({ carregando: { ...s.carregando, [pasta]: true } }))
  try {
    const lista = await worktreeApi.listar(pasta)
    set((s) => {
      const principalDe = { ...s.principalDe }
      const principal = lista?.worktrees.find((w) => w.principal)
      if (lista && principal) {
        // Quando a subpasta do chat não existe num worktree, a pasta dele é a
        // raiz — e o equivalente no principal também é a raiz.
        for (const w of lista.worktrees) {
          if (!w.principal) principalDe[w.pasta] = w.pasta === w.caminho ? principal.caminho : principal.pasta
        }
      }
      return { porPasta: { ...s.porPasta, [pasta]: lista }, principalDe }
    })
    return lista
  } finally {
    set((s) => ({ carregando: { ...s.carregando, [pasta]: false } }))
  }
}

/**
 * Pastas do chat ativo depois que a pasta principal dele mudou fora da tela
 * (o agente trocou de worktree). A sessão em disco só tem as extras do último
 * envio; o workspace tem as atuais — uma pasta associada (ou removida) depois
 * daquele envio só existe nele. Por isso as extras vêm do workspace: copiar
 * a sessão perderia a pasta recém-associada e traria de volta a removida.
 */
export function pastasAposTroca(principal: string, pastasDoWorkspace: string[]): string[] {
  return [principal, ...new Set(pastasDoWorkspace.slice(1).filter((p) => p !== principal))]
}
