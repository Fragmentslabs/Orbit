import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

/** Microphone levels, from the oldest to the newest, and when the last one arrived. */
export interface WaveLevels {
  values: number[]
  at: number
}

/** Duration of a worklet block (1024 frames at 16 kHz): one bar per block. */
const BLOCK_MS = 64
const BAR = 3
const GAP = 3
const STEP = BAR + GAP
/** Below this the bar becomes a dot: silence gets no "dash". */
const FLOOR = 0.04

/**
 * Recording wave: each microphone block enters as a bar from the RIGHT and
 * slides to the left while one speaks; the stretch still without audio stays
 * dotted. Drawn on a canvas by `requestAnimationFrame` — the levels
 * arrive every ~64 ms through a ref, without a React re-render per block.
 *
 * It appears when there is no live text to show (the `live` preference
 * off, or the audio going to the model): it is the feedback that it is recording.
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
      // Keeps only what fits on screen (the recording may last minutes).
      if (values.length > slots + 4) values.splice(0, values.length - slots - 4)
      // Fraction of the slide since the last block: the movement is continuous, not in jumps.
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
        // Opaque background: it covers the text/placeholder of the field while recording.
        "flex h-7 items-center rounded-md bg-background px-1",
        className,
      )}
    >
      <canvas ref={canvasRef} aria-hidden className="h-5 min-w-0 flex-1 text-foreground/70" />
    </div>
  )
}
