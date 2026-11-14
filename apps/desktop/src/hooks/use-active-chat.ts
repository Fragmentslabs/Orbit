import type { ChatStatus, SessionInfo } from "@shared/chat"
import { useWorkspace } from "@/lib/workspace-context"
import { ORPHAN_KEY } from "@/src/stores/panel-store"
import { useActiveRemoteSession, usePeersStore } from "@/src/stores/peers-store"
import { useActiveSession } from "@/src/stores/session-store"
import { useEnvSessionStatus } from "@/src/hooks/use-env-sessions"

export interface ActiveChat {
  /** "local" or the id of the paired desktop picked in the environment selector. */
  env: string
  /** True when the chat on screen lives on another desktop. */
  remote: boolean
  /** The chat on screen: the local id, or the namespaced `peer:<peerId>:<id>`. Undefined = new chat. */
  sessionId: string | undefined
  session: SessionInfo | undefined
  status: ChatStatus | undefined
  /** Bucket of the panel's tabs for this chat (the orphan bucket while there is none). */
  key: string
}

/**
 * The one place that answers "which chat is on screen" for this computer and for
 * another desktop. The right panel, the header and the panel bucket all read it, so the
 * local/remote branch exists once.
 */
export function useActiveChat(): ActiveChat {
  const { mode } = useWorkspace()
  const env = usePeersStore((s) => s.env)
  const localSession = useActiveSession(mode)
  const remoteActive = useActiveRemoteSession()
  const remote = env !== "local"
  const session = remote ? remoteActive?.session : localSession
  const sessionId = remote ? remoteActive?.sessionId : localSession?.id
  const status = useEnvSessionStatus(sessionId)
  return { env, remote, sessionId, session, status, key: sessionId ?? ORPHAN_KEY }
}
