import type { PipelineEvent } from "@shared/pipeline"
import type { RoutineEvent } from "@shared/routines"
import { getActivePeer, namespaced, setActivePeer } from "@/src/lib/env-source"
import { peersApi } from "@/src/lib/ipc"
import { usePeersStore } from "@/src/stores/peers-store"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { useRoutinesStore } from "@/src/stores/routines-store"

/**
 * Keeps the screens that mirror a machine's work (routines, pipeline) pointed at
 * the machine picked in the environment selector.
 *
 * Those stores have one copy of the data, so switching environment empties them
 * and the screens load again — from the other machine (through `ipc.ts`, which
 * asks `getActivePeer()`) or from this one when coming back. Events follow the
 * same rule: the local scheduler's are dropped while another machine is shown
 * (main.tsx) and that machine's are applied here, with its session ids namespaced
 * like every other remote chat.
 */

let started = false

function resetWorkStores(): void {
  useRoutinesStore.setState({
    routines: [],
    runs: [],
    activity: {},
    webhookActivity: {},
    loaded: false,
    openId: null,
    detailsOpen: false,
    detailsTab: "runs",
  })
  usePipelineStore.setState({
    projects: [],
    pipelines: [],
    tasksPerPipeline: {},
    deliveriesPerPipeline: {},
    queueEnabled: {},
    progress: {},
    activity: {},
    loaded: false,
    openPipelineId: null,
    settingsOpen: false,
    planOpen: false,
  })
}

function applyEnv(env: string): void {
  const peer = env === "local" ? null : env
  if (getActivePeer() === peer) return
  setActivePeer(peer)
  resetWorkStores()
}

function remoteRoutineEvent(peerId: string, event: RoutineEvent): RoutineEvent {
  return event.type === "run" ? { ...event, run: { ...event.run, sessionId: namespaced(peerId, event.run.sessionId) } } : event
}

export function startEnvSync(): void {
  if (started || !window.ipcRenderer) return
  started = true
  applyEnv(usePeersStore.getState().env)
  usePeersStore.subscribe((state, prev) => {
    if (state.env !== prev.env) applyEnv(state.env)
  })
  peersApi.onEvent((event) => {
    if (event.type === "routines") {
      if (event.peerId === getActivePeer()) useRoutinesStore.getState().applyEvent(remoteRoutineEvent(event.peerId, event.event))
    } else if (event.type === "pipeline") {
      if (event.peerId === getActivePeer()) usePipelineStore.getState().applyEvent(event.event as PipelineEvent)
    }
  })
}
