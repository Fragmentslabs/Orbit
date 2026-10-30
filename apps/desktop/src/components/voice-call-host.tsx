import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { WorkspaceMode } from "@/lib/workspace-context"
import { useWorkspace } from "@/lib/workspace-context"
import { useVoiceCall } from "@/src/hooks/use-voice-call"
import { useSessionStore } from "@/src/stores/session-store"
import { useVoiceActivity } from "@/src/stores/voice-activity"

/** How long the error notice stays in view after the call drops. */
const ERROR_VISIBLE_MS = 6000

type VoiceCallSubmit = (text: string) => boolean

export interface VoiceCallHost {
  call: ReturnType<typeof useVoiceCall>
  /** Session that owns the call; null only while there is no call. */
  callSessionId: string | null
  /** Workspace in which the call was born — the "open call" goes back to it. */
  callMode: WorkspaceMode | null
  callSessionTitle?: string
  /** Opens the call in the conversation in which it was born (and goes back to the chat). */
  openCall: () => void
  /** Starts a call TIED to this session (the composer already created it if it was a new chat). */
  start: (sessionId: string, mode: WorkspaceMode, submit: VoiceCallSubmit) => void
  /** The composer of the call session registers the most recent submit (folders,
   *  modes and queue change during the conversation). Calls from any OTHER session
   *  are ignored here — the recipient of the speech never changes. */
  registerSubmit: (sessionId: string | undefined, submit: VoiceCallSubmit) => void
}

const VoiceCallContext = createContext<VoiceCallHost | null>(null)

export function useVoiceCallHost(): VoiceCallHost {
  const host = useContext(VoiceCallContext)
  if (!host) throw new Error("useVoiceCallHost must be used within VoiceCallProvider")
  return host
}

/**
 * The call lives HERE, once for the main window — not inside the
 * composer. The composer only shows it when the open conversation is its owner.
 * Switching chat does not change the session of the call: the speech, the answer and the TTS
 * stay tied to `callSessionId`, and the floating card/sidebar access the
 * same state from any screen.
 */
export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const { setMode, setView } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)

  const [callSessionId, setCallSessionId] = useState<string | null>(null)
  const [callMode, setCallMode] = useState<WorkspaceMode | null>(null)
  // Synchronous mirror of the call owner: `registerSubmit` checks through it, and
  // the parent renders before the children — the ref is already updated when the
  // composer of the owner session mounts.
  const callSessionIdRef = useRef<string | null>(null)
  callSessionIdRef.current = callSessionId

  // The submit can NEVER vary with the open chat: it starts tied to the session of the
  // call (the composer passes a function already bound to it) and is only updated
  // by the composer of THAT session when it is mounted. It was through here that the
  // speech fell into the visible chat when the call had been born in a new chat.
  const submitRef = useRef<VoiceCallSubmit | null>(null)
  const submitToCall = useCallback((text: string) => submitRef.current?.(text) ?? false, [])

  const call = useVoiceCall({ sessionId: callSessionId ?? undefined, submit: submitToCall })
  const startCall = call.start

  const activeRef = useRef(call.active)
  activeRef.current = call.active
  // Synchronous lock: two clicks (or two composers) cannot swap the session
  // of the call before React re-renders `call.active`.
  const startingRef = useRef(false)

  const start = useCallback(
    (sessionId: string, mode: WorkspaceMode, submit: VoiceCallSubmit) => {
      if (activeRef.current || startingRef.current) return
      startingRef.current = true
      submitRef.current = submit
      setCallSessionId(sessionId)
      setCallMode(mode)
      startCall()
    },
    [startCall],
  )

  useEffect(() => {
    if (!call.active) startingRef.current = false
  }, [call.active])

  // What registers is the composer of the OPEN chat — but it only counts if it is the owner
  // of the call. Without this guard, opening another chat (or the side panel) could
  // re-point the speech to the visible conversation, which is exactly the bug the
  // `callSessionId` exists to prevent.
  const registerSubmit = useCallback((sessionId: string | undefined, submit: VoiceCallSubmit) => {
    if (sessionId == null || sessionId !== callSessionIdRef.current) return
    submitRef.current = submit
  }, [])

  // The sidebar reads through this store (not through the context): that way the conversation
  // rows do not re-render on every caption tick.
  useEffect(() => {
    useVoiceActivity.getState().setCallSessionId(callSessionId)
  }, [callSessionId])

  useEffect(() => {
    if (!call.error) return
    const timer = setTimeout(call.dismissError, ERROR_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [call.error, call.dismissError])

  const callSessionTitle = useSessionStore((s) =>
    callSessionId ? s.sessions.find((session) => session.id === callSessionId)?.title : undefined,
  )

  const openCall = useCallback(() => {
    if (!callSessionId) return
    const target = callMode ?? "chat"
    setMode(target)
    void selectSession(target, callSessionId)
    setView("chat")
  }, [callSessionId, callMode, setMode, selectSession, setView])

  const value: VoiceCallHost = {
    call,
    callSessionId,
    callMode,
    callSessionTitle,
    openCall,
    start,
    registerSubmit,
  }

  return <VoiceCallContext.Provider value={value}>{children}</VoiceCallContext.Provider>
}
