import { useEffect } from "react"
import { create } from "zustand"
import type { AgentDefinition, ProfileDescription } from "@shared/agents"
import { agentsApi } from "@/src/lib/ipc"

/**
 * The agents the person made and the description of the built-in profiles — a mirror of the
 * main process, loaded the first time anything asks and kept fresh by its change event.
 */
interface AgentsState {
  agents: AgentDefinition[]
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
  builtins: [],
  described: {},
  loaded: false,
  refresh: async () => {
    const snapshot = await agentsApi.snapshot()
    set({ agents: snapshot.agents, builtins: snapshot.builtins, described: snapshot.described, loaded: true })
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
