import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { create } from "zustand"
import type { ComputerShot } from "@shared/computer"
import { cn } from "@/lib/utils"
import { computerApi } from "@/src/lib/ipc"

/**
 * Miniatura do último screenshot da janela controlada, com o alvo da última
 * ação marcado: mostra ONDE o agente agiu mesmo com o app atrás de outras
 * janelas (o screenshot é da janela, não da tela). Vem da memória do main —
 * os screenshots do Computer Use não vão para a galeria nem para o histórico,
 * por isso ela só existe enquanto o controle está ativo.
 *
 * Usada nos painéis flutuantes (Orbit fora de foco), no popover do chip do
 * header e no card fixado acima do campo de mensagem.
 */

/** O último screenshot da conversa, atualizado a cada evento `shot` do main. */
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

/** A miniatura dos painéis flutuantes: some enquanto ainda não há screenshot. */
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
 * Miniatura fixada acima do campo de mensagem, por conversa. Fica em memória
 * de propósito: é um modo de assistir uma tarefa em andamento, não uma
 * preferência — a próxima tarefa começa com o popover, sem card ocupando a tela.
 */
export const useComputerThumbPin = create<{ pinned: Record<string, boolean>; setPinned: (sessionId: string, pinned: boolean) => void }>((set) => ({
  pinned: {},
  setPinned: (sessionId, pinned) => set((state) => ({ pinned: { ...state.pinned, [sessionId]: pinned } })),
}))
