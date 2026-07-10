import { create } from "zustand"
import type { Skill, SkillProposal } from "@/shared/skills"
import type { McpServerStatus } from "@/shared/mcp"
import { mcpApi, skillsApi } from "@/src/lib/ipc"

/**
 * Skills + servidores MCP disponíveis para a paleta "/". O watcher do main
 * avisa mudanças na pasta global (inclusive criações da tool create_skill);
 * a troca de pasta do workspace dispara refresh com o directory ativo.
 */

interface SkillsState {
  initialized: boolean
  skills: Skill[]
  /** Propostas do agente (create_skill) aguardando aprovação no card */
  pending: SkillProposal[]
  mcpServers: McpServerStatus[]
  /** Última pasta usada no refresh (para o watcher recarregar com o mesmo escopo) */
  directory?: string
  initialize: () => Promise<void>
  refresh: (directory?: string) => Promise<void>
  approve: (slug: string) => Promise<void>
  discard: (slug: string) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  initialized: false,
  skills: [],
  pending: [],
  mcpServers: [],
  directory: undefined,

  initialize: async () => {
    if (get().initialized) return
    set({ initialized: true })
    skillsApi.onChanged(() => void get().refresh(get().directory))
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
    await skillsApi.approve(slug) // o notifySkillsChanged do main dispara o refresh
  },

  discard: async (slug) => {
    await skillsApi.discard(slug)
  },
}))
