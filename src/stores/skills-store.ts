import { create } from "zustand"
import type { Skill } from "@/shared/skills"
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
  mcpServers: McpServerStatus[]
  /** Última pasta usada no refresh (para o watcher recarregar com o mesmo escopo) */
  directory?: string
  initialize: () => Promise<void>
  refresh: (directory?: string) => Promise<void>
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  initialized: false,
  skills: [],
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
    const [skills, mcpServers] = await Promise.all([skillsApi.list(dir), mcpApi.status()])
    set({ skills, mcpServers, directory: dir })
  },
}))
