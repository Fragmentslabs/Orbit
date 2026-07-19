"use client"

import {
  type RiveParameters,
  useRive,
  useStateMachineInput,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceColor,
} from "@rive-app/react-webgl2"
import type { FC } from "react"
import { memo, useEffect, useMemo, useRef, useState } from "react"
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

export const Persona: FC<PersonaProps> = memo(
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

Persona.displayName = "Persona"
