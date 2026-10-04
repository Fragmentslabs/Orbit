"use client"

import {
  type RiveParameters,
  RuntimeLoader,
  useRive,
  useStateMachineInput,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceColor,
} from "@rive-app/react-webgl2"
import type { ErrorInfo, FC, ReactNode } from "react"
import {
  Component,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { cn } from "@/lib/utils"
import { useTheme } from "@/components/theme-provider"

export type PersonaState = "idle" | "listening" | "thinking" | "speaking" | "asleep"

interface PersonaProps {
  state: PersonaState
  onLoad?: RiveParameters["onLoad"]
  onLoadError?: RiveParameters["onLoadError"]
  onReady?: () => void
  onPause?: RiveParameters["onPause"]
  onPlay?: RiveParameters["onPlay"]
  onStop?: RiveParameters["onStop"]
  className?: string
}

const stateMachine = "default"

function useResolvedTheme(): "light" | "dark" {
  const { theme } = useTheme()
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  )

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [])

  return theme === "system" ? (systemDark ? "dark" : "light") : theme
}

/* Quando o wasm do Rive aborta, o módulo morre para a página inteira: toda
 * chamada seguinte aborta de novo, inclusive o `rive.bounds` que o useRive lê
 * DURANTE o render. Sem contenção esse throw desmonta a árvore do React e o
 * app fica preto. Por isso a falha é global: marcada uma vez, todas as
 * personas somem até alguém pedir nova tentativa (retryPersona). */
const MAX_RETRIES = 3

let riveStatus = { broken: false, generation: 0 }
let retries = 0
const riveStatusListeners = new Set<() => void>()

function setRiveStatus(next: typeof riveStatus) {
  riveStatus = next
  riveStatusListeners.forEach((listener) => listener())
}

function markRiveBroken() {
  if (!riveStatus.broken) setRiveStatus({ ...riveStatus, broken: true })
}

function subscribeRiveStatus(listener: () => void) {
  riveStatusListeners.add(listener)
  return () => riveStatusListeners.delete(listener)
}

/* O RuntimeLoader guarda o módulo wasm num campo estático e todo Rive novo o
 * pega por awaitInstance(). Zerado o cache, a próxima instância sobe um wasm
 * novo, com memória limpa. Só é seguro com nenhuma persona montada — e com a
 * falha marcada todas já estão no fallback. Limitado para um wasm que aborta
 * sempre não virar um ciclo de recarga a cada troca de chat. */
export function retryPersona() {
  if (!riveStatus.broken || retries >= MAX_RETRIES) return
  retries += 1
  const loader = RuntimeLoader as unknown as { runtime?: unknown; isLoading: boolean }
  loader.runtime = undefined
  loader.isLoading = false
  setRiveStatus({ broken: false, generation: riveStatus.generation + 1 })
}

// Aborts fora do render (loop de animação, microtask do bind) não passam pelo
// boundary; o stack do RuntimeError aponta para o rive.wasm.
function isRiveAbort(error: unknown) {
  return error instanceof Error && (error.stack ?? "").includes("rive.wasm")
}
window.addEventListener("error", (e) => {
  if (isRiveAbort(e.error)) markRiveBroken()
})
window.addEventListener("unhandledrejection", (e) => {
  if (isRiveAbort(e.reason)) markRiveBroken()
})

/* Fica montado mesmo depois da falha: ao trocar o Rive pelo fallback, a
 * limpeza do useRive chama o wasm morto e lança de novo — e esse erro precisa
 * de um boundary ainda montado para não subir até a raiz. */
class PersonaBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[persona] Rive falhou, usando fallback", error, info.componentStack)
    markRiveBroken()
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export const Persona: FC<PersonaProps> = memo((props) => {
  const { broken, generation } = useSyncExternalStore(subscribeRiveStatus, () => riveStatus)
  // Sem Rive a persona some: fica só o espaço dela, para o layout não pular.
  const fallback = <div aria-hidden className={cn("size-32 shrink-0", props.className)} />

  return (
    // A key zera o boundary a cada nova tentativa
    <PersonaBoundary key={generation} fallback={fallback}>
      {broken ? fallback : <RivePersona {...props} />}
    </PersonaBoundary>
  )
})

Persona.displayName = "Persona"

const RivePersona: FC<PersonaProps> = memo(
  ({
    state = "idle",
    onLoad,
    onLoadError,
    onReady,
    onPause,
    onPlay,
    onStop,
    className,
  }) => {
    const theme = useResolvedTheme()
    const source = "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv"

    const callbacksRef = useRef({
      onLoad,
      onLoadError,
      onReady,
      onPause,
      onPlay,
      onStop,
    })
    callbacksRef.current = {
      onLoad,
      onLoadError,
      onReady,
      onPause,
      onPlay,
      onStop,
    }

    const stableCallbacks = useMemo(
      () => ({
        onLoad: (loadedRive =>
          callbacksRef.current.onLoad?.(loadedRive)) as RiveParameters["onLoad"],
        onLoadError: (err =>
          callbacksRef.current.onLoadError?.(err)) as RiveParameters["onLoadError"],
        onReady: () => callbacksRef.current.onReady?.(),
        onPause: (event => callbacksRef.current.onPause?.(event)) as RiveParameters["onPause"],
        onPlay: (event => callbacksRef.current.onPlay?.(event)) as RiveParameters["onPlay"],
        onStop: (event => callbacksRef.current.onStop?.(event)) as RiveParameters["onStop"],
      }),
      [],
    )

    const { rive, RiveComponent } = useRive({
      src: source,
      stateMachines: stateMachine,
      autoplay: true,
      onLoad: stableCallbacks.onLoad,
      onLoadError: stableCallbacks.onLoadError,
      onRiveReady: stableCallbacks.onReady,
      onPause: stableCallbacks.onPause,
      onPlay: stableCallbacks.onPlay,
      onStop: stableCallbacks.onStop,
    })

    const viewModel = useViewModel(rive, { useDefault: true })
    const viewModelInstance = useViewModelInstance(viewModel, {
      rive,
      useDefault: true,
    })
    const viewModelInstanceColor = useViewModelInstanceColor("color", viewModelInstance)

    useEffect(() => {
      if (!viewModelInstanceColor) {
        return
      }
      const [r, g, b] = theme === "dark" ? [255, 255, 255] : [60, 65, 85]
      viewModelInstanceColor.setRgba(r, g, b, 255)
    }, [viewModelInstanceColor, theme])

    const listeningInput = useStateMachineInput(rive, stateMachine, "listening")
    const thinkingInput = useStateMachineInput(rive, stateMachine, "thinking")
    const speakingInput = useStateMachineInput(rive, stateMachine, "speaking")
    const asleepInput = useStateMachineInput(rive, stateMachine, "asleep")

    useEffect(() => {
      if (listeningInput) {
        listeningInput.value = state === "listening"
      }
      if (thinkingInput) {
        thinkingInput.value = state === "thinking"
      }
      if (speakingInput) {
        speakingInput.value = state === "speaking"
      }
      if (asleepInput) {
        asleepInput.value = state === "asleep"
      }
    }, [state, listeningInput, thinkingInput, speakingInput, asleepInput])

    return (
      <div
        className={cn("size-32 shrink-0", className)}
        style={{
          filter:
            theme === "light"
              ? "invert(1) brightness(0.85)"
              : "drop-shadow(0 0 18px rgba(255,255,255,0.7)) brightness(1.4)",
        }}
      >
        <RiveComponent className="size-full" />
      </div>
    )
  },
)

RivePersona.displayName = "RivePersona"
