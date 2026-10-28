import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { WorkspaceMode } from "@/lib/workspace-context"
import { useWorkspace } from "@/lib/workspace-context"
import { useVoiceCall } from "@/src/hooks/use-voice-call"
import { useSessionStore } from "@/src/stores/session-store"
import { useVoiceActivity } from "@/src/stores/voice-activity"

/** Quanto o aviso de erro fica à vista depois de a chamada cair. */
const ERROR_VISIBLE_MS = 6000

type VoiceCallSubmit = (text: string) => boolean

export interface VoiceCallHost {
  call: ReturnType<typeof useVoiceCall>
  /** Sessão dona da chamada; null só enquanto não há chamada. */
  callSessionId: string | null
  /** Workspace em que a chamada nasceu — o "abrir chamada" volta para ele. */
  callMode: WorkspaceMode | null
  callSessionTitle?: string
  /** Abre a chamada na conversa em que ela nasceu (e volta para o chat). */
  openCall: () => void
  /** Começa uma chamada PRESA a esta sessão (o composer já a criou se era chat novo). */
  start: (sessionId: string, mode: WorkspaceMode, submit: VoiceCallSubmit) => void
  /** O composer da sessão da chamada registra o submit mais recente (pastas,
   *  modos e fila mudam durante a conversa). Chamadas de qualquer OUTRA sessão
   *  são ignoradas aqui — o destinatário da fala nunca muda. */
  registerSubmit: (sessionId: string | undefined, submit: VoiceCallSubmit) => void
}

const VoiceCallContext = createContext<VoiceCallHost | null>(null)

export function useVoiceCallHost(): VoiceCallHost {
  const host = useContext(VoiceCallContext)
  if (!host) throw new Error("useVoiceCallHost must be used within VoiceCallProvider")
  return host
}

/**
 * A chamada vive AQUI, uma vez para a janela principal — não dentro do
 * composer. O composer só a mostra quando a conversa aberta é a dona dela.
 * Trocar de chat não muda a sessão da chamada: a fala, a resposta e o TTS
 * continuam presos a `callSessionId`, e o card flutuante/sidebar acessam o
 * mesmo estado de qualquer tela.
 */
export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const { setMode, setView } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)

  const [callSessionId, setCallSessionId] = useState<string | null>(null)
  const [callMode, setCallMode] = useState<WorkspaceMode | null>(null)
  // Espelho síncrono do dono da chamada: o `registerSubmit` confere por ele, e
  // o pai renderiza antes dos filhos — o ref já está atualizado quando o
  // composer da sessão dona monta.
  const callSessionIdRef = useRef<string | null>(null)
  callSessionIdRef.current = callSessionId

  // O submit JAMAIS pode variar com o chat aberto: começa preso à sessão da
  // chamada (o composer passa uma função já amarrada nela) e só é atualizado
  // pelo composer DESSA sessão quando ele está montado. Era por aqui que a
  // fala caía no chat visível quando a chamada tinha nascido num chat novo.
  const submitRef = useRef<VoiceCallSubmit | null>(null)
  const submitToCall = useCallback((text: string) => submitRef.current?.(text) ?? false, [])

  const call = useVoiceCall({ sessionId: callSessionId ?? undefined, submit: submitToCall })
  const startCall = call.start

  const activeRef = useRef(call.active)
  activeRef.current = call.active
  // Trava síncrona: dois cliques (ou dois composers) não podem trocar a sessão
  // da chamada antes de o React re-renderizar `call.active`.
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

  // Quem registra é o composer do chat ABERTO — mas só vale se ele for o dono
  // da chamada. Sem esta guarda, abrir outro chat (ou o painel lateral) poderia
  // reapontar a fala para a conversa visível, que é exatamente o bug que o
  // `callSessionId` existe para impedir.
  const registerSubmit = useCallback((sessionId: string | undefined, submit: VoiceCallSubmit) => {
    if (sessionId == null || sessionId !== callSessionIdRef.current) return
    submitRef.current = submit
  }, [])

  // A sidebar lê por este store (não pelo contexto): assim as linhas de
  // conversa não re-renderizam a cada tique da legenda.
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
