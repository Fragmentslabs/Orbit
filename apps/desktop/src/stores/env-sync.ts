import type { PipelineEvent } from "@shared/pipeline"
import type { RoutineEvent } from "@shared/routines"
import { getActivePeer, namespaced, setActivePeer } from "@/src/lib/env-source"
import { peersApi } from "@/src/lib/ipc"
import { refreshRemoteProviders } from "@/src/hooks/use-env-providers"
import { useMemoryStore } from "@/src/stores/memory-store"
import { usePeersStore } from "@/src/stores/peers-store"
import { useSkillsStore } from "@/src/stores/skills-store"
import { applyPeerSync, useRemoteSyncStore } from "@/src/stores/remote-sync-store"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { useRoutinesStore } from "@/src/stores/routines-store"

/**
 * Keeps the screens that mirror a machine's work (routines, pipeline, memories, tools) pointed at
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
  useMemoryStore.getState().reset()
  resetToolsStore()
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

/** The "/" palette and the tools menu read the skills and MCP servers of the machine on screen. */
function resetToolsStore(): void {
  const skills = useSkillsStore.getState()
  skills.reset()
  if (skills.initialized) void skills.refresh().catch(() => {})
}

function applyEnv(env: string): void {
  const peer = env === "local" ? null : env
  if (getActivePeer() === peer) return
  setActivePeer(peer)
  resetWorkStores()
}

function peerOnline(state: ReturnType<typeof usePeersStore.getState>, peerId: string): boolean {
  return state.snapshot?.peers.find((p) => p.peerId === peerId)?.online === true
}

/**
 * The machine on screen came back after being unreachable: what it changed meanwhile
 * (events are not replayed) is read again, in place — the screens keep showing the old
 * data until the new arrives. A store nobody opened yet has nothing stale to refresh.
 */
function refreshAfterReconnect(peerId: string): void {
  if (useRoutinesStore.getState().loaded) void useRoutinesStore.getState().load().catch(() => {})
  if (usePipelineStore.getState().loaded) void usePipelineStore.getState().load().catch(() => {})
  if (useMemoryStore.getState().initialized) void useMemoryStore.getState().refresh().catch(() => {})
  if (useSkillsStore.getState().initialized) void useSkillsStore.getState().refresh().catch(() => {})
  void refreshRemoteProviders(peerId)
  if (useRemoteSyncStore.getState().byPeer[peerId]) void useRemoteSyncStore.getState().load(peerId, true)
}

function remoteRoutineEvent(peerId: string, event: RoutineEvent): RoutineEvent {
  return event.type === "run" ? { ...event, run: { ...event.run, sessionId: namespaced(peerId, event.run.sessionId) } } : event
}

export function startEnvSync(): void {
  if (started || !window.ipcRenderer) return
  started = true
  applyEnv(usePeersStore.getState().env)
  usePeersStore.subscribe((state, prev) => {
    if (state.env !== prev.env) {
      applyEnv(state.env)
      return
    }
    // Same machine, offline → online: reload what went stale.
    if (state.env !== "local" && !peerOnline(prev, state.env) && peerOnline(state, state.env)) refreshAfterReconnect(state.env)
  })
  peersApi.onEvent((event) => {
    if (event.type === "routines") {
      if (event.peerId === getActivePeer()) useRoutinesStore.getState().applyEvent(remoteRoutineEvent(event.peerId, event.event))
    } else if (event.type === "memory") {
      if (event.peerId === getActivePeer()) useMemoryStore.getState().applyEvent(event.event)
    } else if (event.type === "sync") {
      // Per-chat settings and the queue of ANY paired machine: a chat open there reads them.
      applyPeerSync(event.peerId, event.event)
    } else if (event.type === "pipeline") {
      if (event.peerId === getActivePeer()) usePipelineStore.getState().applyEvent(event.event as PipelineEvent)
    }
  })
}
