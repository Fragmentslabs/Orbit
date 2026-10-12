import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

/** Níveis do microfone, do mais antigo ao mais novo, e quando chegou o último. */
export interface WaveLevels {
  values: number[]
  at: number
}

/** Duração de um bloco do worklet (1024 quadros a 16 kHz): uma barra por bloco. */
const BLOCK_MS = 64
const BAR = 3
const GAP = 3
const STEP = BAR + GAP
/** Abaixo disto a barra vira ponto: silêncio não ganha "risco". */
const FLOOR = 0.04

/**
 * Onda da gravação: cada bloco do microfone entra como uma barra pela DIREITA e
 * desliza para a esquerda enquanto se fala; o trecho ainda sem áudio fica
 * pontilhado. Desenhada num canvas por `requestAnimationFrame` — os níveis
 * chegam a cada ~64 ms por ref, sem re-render do React por bloco.
 *
 * Aparece quando não há texto ao vivo para mostrar (preferência `live`
 * desligada, ou o áudio indo para o modelo): é o retorno de que está gravando.
 */
export function DictationWave({
  levels,
  className,
}: {
  levels: React.MutableRefObject<WaveLevels>
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let width = 0
    let height = 0
    let color = "currentColor"

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      color = getComputedStyle(canvas).color
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const { values, at } = levels.current
      const slots = Math.ceil(width / STEP) + 1
      // Mantém só o que cabe na tela (a gravação pode durar minutos).
      if (values.length > slots + 4) values.splice(0, values.length - slots - 4)
      // Fração do deslize desde o último bloco: o movimento é contínuo, não aos saltos.
      const frac = reduceMotion ? 1 : Math.min(1, (performance.now() - at) / BLOCK_MS)
      const mid = height / 2
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = color
      for (let k = 0; k < slots; k++) {
        const x = width - k * STEP - frac * STEP + GAP / 2
        if (x + BAR < 0) break
        const level = values[values.length - 1 - k]
        if (level === undefined || level < FLOOR) {
          ctx.globalAlpha = 0.45
          ctx.beginPath()
          ctx.arc(x + BAR / 2, mid, 1, 0, Math.PI * 2)
          ctx.fill()
          continue
        }
        ctx.globalAlpha = 0.9
        const h = Math.max(BAR, level * (height - 2))
        ctx.beginPath()
        ctx.roundRect(x, mid - h / 2, BAR, h, BAR / 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    draw()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [levels])

  return (
    <div
      className={cn(
        // Fundo opaco: cobre o texto/placeholder do campo enquanto grava.
        "flex h-7 items-center rounded-md bg-background px-1",
        className,
      )}
    >
      <canvas ref={canvasRef} aria-hidden className="h-5 min-w-0 flex-1 text-foreground/70" />
    </div>
  )
}
