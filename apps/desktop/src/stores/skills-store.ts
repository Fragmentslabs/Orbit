import { create } from "zustand"
import type { Skill, SkillMetaView, SkillProposal } from "@shared/skills"
import type { McpServerStatus } from "@shared/mcp"
import { mcpApi, skillsApi } from "@/src/lib/ipc"

/**
 * Skills + MCP servers available to the "/" palette. Main's watcher
 * reports changes in the global folder (including creations from the create_skill tool);
 * changing the workspace folder triggers a refresh with the active directory.
 *
 * It follows the environment selector like the other mirrors: `skillsApi`/`mcpApi` answer from
 * the machine on screen, and env-sync empties and reloads this store when it changes.
 *
 * "discarded" keeps the slugs the USER really refused in the card
 * (persisted in localStorage). It is the only source for the "dismissed" state —
 * absence from "pending" is never treated as a refusal.
 */

const DISCARDED_KEY = "orbit_skill_proposals_discarded"

interface SkillsState {
  initialized: boolean
  skills: Skill[]
  /** Card state, preferences and usage of each skill, by slug */
  meta: Record<string, SkillMetaView>
  /** Agent proposals (create_skill) awaiting approval in the card */
  pending: SkillProposal[]
  mcpServers: McpServerStatus[]
  /** Slugs refused by the user (not inferred from absence in pending) */
  discarded: string[]
  /** Last folder used in the refresh (so the watcher reloads with the same scope) */
  directory?: string
  initialize: () => Promise<void>
  refresh: (directory?: string) => Promise<void>
  /** Only the MCP servers (the composer's tools menu needs no skills). */
  refreshServers: () => Promise<void>
  /** The environment changed: what is here belongs to the other machine. */
  reset: () => void
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
  meta: {},
  pending: [],
  mcpServers: [],
  discarded: loadDiscarded(),
  directory: undefined,

  initialize: async () => {
    // Listener registered only once; the refresh runs on every initialize —
    // every proposal card that mounts re-syncs with the disk, so the card
    // never gets "stuck" without the proposal just staged by the tool.
    if (!get().initialized) {
      set({ initialized: true })
      skillsApi.onChanged(() => void get().refresh(get().directory))
    }
    await get().refresh()
  },

  refresh: async (directory) => {
    const dir = directory ?? get().directory
    const [skills, pending, mcpServers, metaList] = await Promise.all([
      skillsApi.list(dir),
      skillsApi.pending(),
      mcpApi.status(),
      skillsApi.meta(dir).catch(() => []),
    ])
    set({
      skills,
      pending,
      mcpServers,
      meta: Object.fromEntries(metaList.map((m) => [m.slug, m])),
      directory: dir,
    })
  },

  refreshServers: async () => {
    set({ mcpServers: await mcpApi.status() })
  },

  reset: () => set({ skills: [], meta: {}, pending: [], mcpServers: [], directory: undefined }),

  approve: async (slug) => {
    const ok = await skillsApi.approve(slug)
    // Resolves the local state without depending on the skills:changed event
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
