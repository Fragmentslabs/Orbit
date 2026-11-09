import { useEffect, useMemo } from "react"
import { create } from "zustand"
import { AGENT_FORMAT_VERSION, userProfileId, type AgentDefinition, type AgentPromptSection, type EphemeralAgent, type ProfileDescription } from "@shared/agents"
import { agentsApi } from "@/src/lib/ipc"

/**
 * The agents the person made and the description of the built-in profiles — a mirror of the
 * main process, loaded the first time anything asks and kept fresh by its change event.
 */
interface AgentsState {
  agents: AgentDefinition[]
  ephemeral: EphemeralAgent[]
  sectionWeights: Partial<Record<AgentPromptSection, number>>
  builtins: ProfileDescription[]
  described: Record<string, ProfileDescription>
  loaded: boolean
  /** Loads once and starts listening; later calls are free. */
  ensure: () => void
  refresh: () => Promise<void>
}

let listening = false

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  ephemeral: [],
  sectionWeights: {},
  builtins: [],
  described: {},
  loaded: false,
  refresh: async () => {
    const snapshot = await agentsApi.snapshot()
    set({ agents: snapshot.agents, ephemeral: snapshot.ephemeral, sectionWeights: snapshot.sectionWeights, builtins: snapshot.builtins, described: snapshot.described, loaded: true })
  },
  ensure: () => {
    if (listening) return
    listening = true
    agentsApi.onChanged(() => void get().refresh())
    void get().refresh()
  },
}))

/** The agents list for a component: loads it on first use and re-renders when it changes. */
export function useAgents(): AgentDefinition[] {
  const agents = useAgentsStore((s) => s.agents)
  const ensure = useAgentsStore((s) => s.ensure)
  useEffect(() => ensure(), [ensure])
  return agents
}

/**
 * Every agent a chat may be running, for showing it: the saved ones plus the temporary ones
 * an orchestrator defined. A temporary agent that was saved answers to its old id as the saved
 * agent, so chats that started with it keep their badge. Not for lists the person picks from.
 */
export function useAgentLookup(): AgentDefinition[] {
  const agents = useAgents()
  const ephemeral = useAgentsStore((s) => s.ephemeral)
  return useMemo(() => {
    const aliases = ephemeral.flatMap((e): AgentDefinition[] => {
      const saved = e.savedAs ? agents.find((a) => a.id === e.savedAs) : undefined
      if (saved) return [{ ...saved, id: e.id }]
      if (e.savedAs) return []
      return [{ ...e.input, version: AGENT_FORMAT_VERSION, id: e.id, origin: "user", createdAt: e.createdAt, updatedAt: e.createdAt }]
    })
    return [...agents, ...aliases]
  }, [agents, ephemeral])
}

/** True when the profile is a temporary agent that has not been saved. */
export function useIsTemporary(profile: string | undefined): boolean {
  return useAgentsStore((s) => Boolean(profile) && s.ephemeral.some((e) => !e.savedAs && userProfileId(e.id) === profile))
}
