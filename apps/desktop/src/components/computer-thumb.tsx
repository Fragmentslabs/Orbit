import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { create } from "zustand"
import type { ComputerShot } from "@shared/computer"
import { cn } from "@/lib/utils"
import { computerApi } from "@/src/lib/ipc"

/**
 * Thumbnail of the last screenshot of the controlled window, with the target of the last
 * action marked: it shows WHERE the agent acted even with the app behind other
 * windows (the screenshot is of the window, not of the screen). It comes from the memory of the main process —
 * the Computer Use screenshots go neither to the gallery nor to the history,
 * which is why it only exists while the control is active.
 *
 * Used in the floating panels (Orbit out of focus), in the popover of the header
 * chip and in the card pinned above the message field.
 */

/** The last screenshot of the conversation, updated on every `shot` event from the main process. */
export function useComputerShot(sessionId: string | undefined): ComputerShot | null {
  const [shot, setShot] = useState<ComputerShot | null>(null)
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const load = () =>
      void computerApi.shot(sessionId).then((next) => {
        if (alive) setShot(next)
      })
    load()
    const off = computerApi.onEvent((event) => {
      if (event.type === "shot" && event.sessionId === sessionId) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [sessionId])
  return shot
}

export function ComputerShotImage({ shot, className }: { shot: ComputerShot; className?: string }) {
  const { t } = useTranslation()
  const pct = (value: number, total: number) => `${(value / total) * 100}%`
  const marker = shot.marker
  const isPoint = marker && marker.w < 4 && marker.h < 4
  return (
    <div className={cn("relative overflow-hidden rounded-md border bg-muted", className)} style={{ aspectRatio: `${shot.width} / ${shot.height}` }}>
      <img src={shot.dataUrl} alt={t("computer.panels.shotAlt", { app: shot.app })} className="absolute inset-0 size-full object-cover" draggable={false} />
      {marker &&
        (isPoint ? (
          <span
            title={marker.label}
            className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/30 shadow"
            style={{ left: pct(marker.x, shot.width), top: pct(marker.y, shot.height) }}
          />
        ) : (
          <span
            title={marker.label}
            className="absolute rounded-sm border-2 border-primary bg-primary/15 shadow"
            style={{
              left: pct(marker.x, shot.width),
              top: pct(marker.y, shot.height),
              width: pct(Math.max(marker.w, 6), shot.width),
              height: pct(Math.max(marker.h, 6), shot.height),
            }}
          />
        ))}
    </div>
  )
}

/** The thumbnail of the floating panels: it disappears while there is no screenshot yet. */
export function ComputerShotThumb({ sessionId }: { sessionId: string }) {
  const shot = useComputerShot(sessionId)
  if (!shot) return null
  return (
    <div className="border-b p-2">
      <ComputerShotImage shot={shot} />
    </div>
  )
}

/**
 * Thumbnail pinned above the message field, per conversation. It stays in memory
 * on purpose: it is a way of watching a task in progress, not a
 * preference — the next task starts with the popover, with no card taking up the screen.
 */
export const useComputerThumbPin = create<{ pinned: Record<string, boolean>; setPinned: (sessionId: string, pinned: boolean) => void }>((set) => ({
  pinned: {},
  setPinned: (sessionId, pinned) => set((state) => ({ pinned: { ...state.pinned, [sessionId]: pinned } })),
}))
