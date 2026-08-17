import { create } from "zustand"
import type { Skill, SkillProposal } from "@shared/skills"
import type { McpServerStatus } from "@shared/mcp"
import { mcpApi, skillsApi } from "@/src/lib/ipc"

/**
 * Skills + servidores MCP disponíveis para a paleta "/". O watcher do main
 * avisa mudanças na pasta global (inclusive criações da tool create_skill);
 * a troca de pasta do workspace dispara refresh com o directory ativo.
 *
 * "discarded" guarda os slugs que o USUÁRIO realmente recusou no card
 * (persistido em localStorage). É a única fonte para o estado "dispensada" —
 * a ausência em "pending" nunca é tratada como recusa.
 */

const DISCARDED_KEY = "orbit_skill_proposals_discarded"

interface SkillsState {
  initialized: boolean
  skills: Skill[]
  /** Propostas do agente (create_skill) aguardando aprovação no card */
  pending: SkillProposal[]
  mcpServers: McpServerStatus[]
  /** Slugs recusados pelo usuário (não inferidos pela ausência em pending) */
  discarded: string[]
  /** Última pasta usada no refresh (para o watcher recarregar com o mesmo escopo) */
  directory?: string
  initialize: () => Promise<void>
  refresh: (directory?: string) => Promise<void>
  approve: (slug: string) => Promise<boolean>
  discard: (slug: string) => Promise<void>
}

function loadDiscarded(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISCARDED_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  initialized: false,
  skills: [],
  pending: [],
  mcpServers: [],
  discarded: loadDiscarded(),
  directory: undefined,

  initialize: async () => {
    // Listener registrado uma única vez; o refresh roda em cada initialize —
    // cada card de proposta que monta re-sincroniza com o disco, então o card
    // nunca fica "preso" sem a proposta recém-estagiada pela tool.
    if (!get().initialized) {
      set({ initialized: true })
      skillsApi.onChanged(() => void get().refresh(get().directory))
    }
    await get().refresh()
  },

  refresh: async (directory) => {
    const dir = directory ?? get().directory
    const [skills, pending, mcpServers] = await Promise.all([
      skillsApi.list(dir),
      skillsApi.pending(),
      mcpApi.status(),
    ])
    set({ skills, pending, mcpServers, directory: dir })
  },

  approve: async (slug) => {
    const ok = await skillsApi.approve(slug)
    // Resolve o estado local sem depender do evento skills:changed
    set((s) => ({ discarded: s.discarded.filter((d) => d !== slug) }))
    localStorage.setItem(DISCARDED_KEY, JSON.stringify(get().discarded))
    await get().refresh()
    return ok
  },

  discard: async (slug) => {
    await skillsApi.discard(slug)
    set((s) => ({ discarded: [...new Set([...s.discarded, slug])] }))
    localStorage.setItem(DISCARDED_KEY, JSON.stringify(get().discarded))
    await get().refresh()
  },
}))
