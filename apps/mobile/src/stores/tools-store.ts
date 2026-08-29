import { create } from 'zustand'
import type { Skill, SkillProposal, McpServerStatus, McpConfig } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'

const SKILLS_CACHE_KEY = 'orbit_skills_cache'
const MCP_CACHE_KEY = 'orbit_mcp_cache'
const PENDING_CACHE_KEY = 'orbit_skills_pending_cache'
const DISCARDED_CACHE_KEY = 'orbit_skills_discarded_cache'

interface ToolsState {
  skills: Skill[]
  mcpServers: McpServerStatus[]
  pending: SkillProposal[]
  /** Slugs recusados pelo usuário (não inferidos pela ausência em pending) */
  discarded: string[]
  loading: boolean

  fetchSkills: (directory?: string) => Promise<void>
  fetchMcpStatus: () => Promise<void>
  fetchPending: () => Promise<void>
  hydrateCache: () => Promise<void>

  createSkill: (data: { name: string; description?: string; content: string; slug?: string }) => Promise<void>
  removeSkill: (slug: string) => Promise<void>
  importSkill: (content: string, filename: string) => Promise<void>
  approveSkill: (slug: string) => Promise<void>
  discardSkill: (slug: string) => Promise<void>

  saveMcpConfig: (config: McpConfig) => Promise<void>
  reconnectMcp: (name?: string) => Promise<void>
  authorizeMcp: (name: string) => Promise<void>
}

/** Enquanto o usuário conclui o login no navegador do desktop, o servidor
 *  fica em "connecting" — o app acompanha o desfecho por polling. */
const AUTH_POLL_INTERVAL_MS = 3_000
const AUTH_POLL_ATTEMPTS = 40 // ~2 minutos

export const useToolsStore = create<ToolsState>((set, get) => ({
  skills: [],
  mcpServers: [],
  pending: [],
  discarded: [],
  loading: false,

  fetchSkills: async (directory) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    set({ loading: true })
    try {
      const res = await http.getSkills(directory)
      if (res.ok && res.data) {
        const skills = res.data as Skill[]
        set({ skills })
        void Storage.setItem(SKILLS_CACHE_KEY, JSON.stringify(skills))
      }
    } finally {
      set({ loading: false })
    }
  },

  fetchMcpStatus: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    try {
      const res = await http.getMcpStatus()
      if (res.ok && res.data) {
        const mcpServers = res.data as McpServerStatus[]
        set({ mcpServers })
        void Storage.setItem(MCP_CACHE_KEY, JSON.stringify(mcpServers))
      }
    } catch {
    }
  },

  fetchPending: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    try {
      const res = await http.listPendingSkills()
      if (res.ok && res.data) {
        const pending = res.data as SkillProposal[]
        set({ pending })
        void Storage.setItem(PENDING_CACHE_KEY, JSON.stringify(pending))
      }
    } catch {
    }
  },

  hydrateCache: async () => {
    try {
      const [rawSkills, rawMcp, rawPending, rawDiscarded] = await Promise.all([
        Storage.getItem(SKILLS_CACHE_KEY),
        Storage.getItem(MCP_CACHE_KEY),
        Storage.getItem(PENDING_CACHE_KEY),
        Storage.getItem(DISCARDED_CACHE_KEY),
      ])
      if (rawSkills) set({ skills: JSON.parse(rawSkills) as Skill[] })
      if (rawMcp) set({ mcpServers: JSON.parse(rawMcp) as McpServerStatus[] })
      if (rawPending) set({ pending: JSON.parse(rawPending) as SkillProposal[] })
      if (rawDiscarded) set({ discarded: JSON.parse(rawDiscarded) as string[] })
    } catch {
    }
  },

  createSkill: async (data) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.createSkill(data)
    if (res.ok) {
      await get().fetchSkills()
    }
  },

  removeSkill: async (slug) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.removeSkill(slug)
    if (res.ok) {
      set((s) => ({ skills: s.skills.filter((sk) => sk.slug !== slug) }))
    }
  },

  importSkill: async (content, filename) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.importSkill(content, filename)
    if (res.ok && (res.data as { imported: boolean })?.imported) {
      await get().fetchSkills()
    }
  },

  approveSkill: async (slug) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.approveSkill(slug)
    if (res.ok) {
      set((s) => ({
        pending: s.pending.filter((p) => p.slug !== slug),
        discarded: s.discarded.filter((d) => d !== slug),
      }))
      void Storage.setItem(DISCARDED_CACHE_KEY, JSON.stringify(get().discarded))
      await get().fetchSkills()
    }
  },

  discardSkill: async (slug) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.discardSkill(slug)
    if (res.ok) {
      set((s) => ({
        pending: s.pending.filter((p) => p.slug !== slug),
        discarded: [...new Set([...s.discarded, slug])],
      }))
      void Storage.setItem(DISCARDED_CACHE_KEY, JSON.stringify(get().discarded))
    }
  },

  saveMcpConfig: async (config) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.saveMcpConfig(config)
    if (res.ok && res.data) {
      set({ mcpServers: res.data as McpServerStatus[] })
      void Storage.setItem(MCP_CACHE_KEY, JSON.stringify(res.data))
    }
  },

  reconnectMcp: async (name) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.reconnectMcp(name)
    if (res.ok && res.data) {
      set({ mcpServers: res.data as McpServerStatus[] })
    }
  },

  /**
   * Pede ao desktop para abrir o fluxo OAuth do servidor. O navegador abre no
   * computador (o redirect é o loopback de lá), então aqui só resta acompanhar:
   * o desktop responde na hora e o status é consultado até sair de "connecting".
   */
  authorizeMcp: async (name) => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    const res = await http.authorizeMcp(name)
    if (!res.ok) return
    if (res.data) set({ mcpServers: res.data as McpServerStatus[] })
    for (let attempt = 0; attempt < AUTH_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_INTERVAL_MS))
      await get().fetchMcpStatus()
      const server = get().mcpServers.find((s) => s.config.name === name)
      if (server && server.state !== 'connecting') return
    }
  },
}))
