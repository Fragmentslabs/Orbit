import { create } from 'zustand'
import type { Skill } from '@orbit/shared'
import type { McpServerStatus } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'

const SKILLS_CACHE_KEY = 'orbit_skills_cache'
const MCP_CACHE_KEY = 'orbit_mcp_cache'

interface ToolsState {
  skills: Skill[]
  mcpServers: McpServerStatus[]
  loading: boolean

  fetchSkills: (directory?: string) => Promise<void>
  fetchMcpStatus: () => Promise<void>
  hydrateCache: () => Promise<void>
}

export const useToolsStore = create<ToolsState>((set) => ({
  skills: [],
  mcpServers: [],
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

  hydrateCache: async () => {
    try {
      const [rawSkills, rawMcp] = await Promise.all([
        Storage.getItem(SKILLS_CACHE_KEY),
        Storage.getItem(MCP_CACHE_KEY),
      ])
      if (rawSkills) {
        set({ skills: JSON.parse(rawSkills) as Skill[] })
      }
      if (rawMcp) {
        set({ mcpServers: JSON.parse(rawMcp) as McpServerStatus[] })
      }
    } catch {
    }
  },
}))
