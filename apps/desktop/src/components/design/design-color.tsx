import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { Pipette, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { hexToRgb, hsvToHex, rgbToHsv, toHex, type Hsv } from "./design-protocol"

/**
 * Seletor de cor do inspetor — no lugar do `<input type="color">` do sistema.
 *
 * O nativo abre uma janela do SO, fora do tema do app, e não sabe o que é a
 * paleta da tela. Aqui a cor é escolhida na própria janela: a área de
 * saturação/valor com o cursor, a faixa de matiz, o hex e o conta-gotas (o
 * EyeDropper do Chromium, quando existe).
 *
 * A escolha é confirmada UMA vez, no fim do arraste: cada passo de escrita
 * seria uma escrita no arquivo (e um passo de desfazer) por pixel.
 */

/** O cursor da área de saturação/valor: um anel na cor escolhida. */
function Cursor({ left, top }: { left: number; top: number }) {
  return (
    <span
      className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
      style={{ left: `${left * 100}%`, top: `${top * 100}%` }}
    />
  )
}

/** Faixa do matiz: o arco-íris com o cursor na cor escolhida. */
const HUE_BG = "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)"

export function ColorPicker({
  value,
  computed,
  onCommit,
}: {
  /** O valor no `style` do elemento (o que o painel edita). */
  value: string
  /** O valor computado — o ponto de partida quando não há valor no `style`. */
  computed: string
  onCommit: (value: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(toHex(value || computed) ?? "#000000") ?? { r: 0, g: 0, b: 0 }))
  const [hexDraft, setHexDraft] = useState(() => toHex(value || computed) ?? "#000000")
  const squareRef = useRef<HTMLDivElement | null>(null)
  const hueRef = useRef<HTMLDivElement | null>(null)

  const shown = value || computed
  const hex = toHex(shown)
  const transparent = !shown || hex === null

  /** O valor canônico do estado atual (o hex do HSV). */
  const current = hsvToHex(hsv)

  const setHue = (h: number) => {
    const next = { ...hsv, h }
    setHsv(next)
    setHexDraft(hsvToHex(next))
  }

  const setSaturationValue = (s: number, v: number) => {
    const next = { ...hsv, s, v }
    setHsv(next)
    setHexDraft(hsvToHex(next))
  }

  const fromPointer = (event: ReactPointerEvent, el: HTMLElement, kind: "sv" | "hue") => {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    if (kind === "hue") {
      setHue(Math.max(0, Math.min(360, ((event.clientX - rect.left) / rect.width) * 360)))
      return
    }
    const s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const v = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height))
    setSaturationValue(s, v)
  }

  /** Arraste com o ponteiro preso: a cor anda com o mouse, sem passar pela tecla. */
  const drag = (event: ReactPointerEvent, el: HTMLElement, kind: "sv" | "hue") => {
    el.setPointerCapture(event.pointerId)
    fromPointer(event, el, kind)
  }

  const endDrag = (event: ReactPointerEvent, el: HTMLElement) => {
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
    onCommit(hsvToHex(hsv))
  }

  /** O conta-gotas do Chromium: a cor de qualquer pixel da tela. */
  const pickWithEye = async () => {
    const eye = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!eye) return
    try {
      const result = await new eye().open()
      const rgb = result?.sRGBHex ? hexToRgb(result.sRGBHex) : null
      if (!rgb) return
      const next = rgbToHsv(rgb)
      setHsv(next)
      setHexDraft(result.sRGBHex)
      onCommit(result.sRGBHex)
    } catch {
      // O usuário cancelou a seleção.
    }
  }

  /** O hex digitado: entra só quando é um hex de verdade. */
  const applyHexDraft = (next: string) => {
    setHexDraft(next)
    const rgb = hexToRgb(next)
    if (rgb) setHsv(rgbToHsv(rgb))
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Ao abrir, o valor pode ter mudado (o grupo, o estilo): o seletor
        // nasce do que está valendo agora.
        if (next) {
          const start = toHex(value || computed) ?? "#000000"
          setHexDraft(start)
          setHsv(rgbToHsv(hexToRgb(start) ?? { r: 0, g: 0, b: 0 }))
        }
      }}
    >
      {/* A amostra É o gatilho: a cor que o elemento tem (ou o xadrez, quando
          não tem cor nenhuma). */}
      <PopoverTrigger
        title={t("design.props.colorPicker")}
        aria-label={t("design.props.colorPicker")}
        className="size-4 shrink-0 cursor-pointer overflow-hidden rounded-[4px] border border-border/70 transition-transform hover:scale-110"
        style={{
          background: transparent
            ? "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%) 50% / 6px 6px"
            : shown,
        }}
      />
      <PopoverContent align="start" side="bottom" className="w-60 p-2">
        <div className="flex flex-col gap-2">
          {/* Saturação e valor: o matiz embaixo, o branco à esquerda e o
              preto embaixo. */}
          <div
            ref={squareRef}
            onPointerDown={(e) => drag(e, e.currentTarget, "sv")}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e, e.currentTarget, "sv")
            }}
            onPointerUp={(e) => endDrag(e, e.currentTarget)}
            className="relative h-28 w-full cursor-crosshair overflow-hidden rounded-md"
            style={{
              backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
              backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
            }}
          >
            <Cursor left={hsv.s} top={1 - hsv.v} />
          </div>

          {/* Matiz. */}
          <div
            ref={hueRef}
            onPointerDown={(e) => drag(e, e.currentTarget, "hue")}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e, e.currentTarget, "hue")
            }}
            onPointerUp={(e) => endDrag(e, e.currentTarget)}
            className="relative h-3 w-full cursor-pointer rounded-full"
            style={{ background: HUE_BG }}
          >
            <span
              className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
              style={{ left: `${(hsv.h / 360) * 100}%` }}
            />
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-input bg-input/20 px-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30">
              <span className="shrink-0 select-none text-[9px] font-bold text-muted-foreground/60">#</span>
              <input
                value={hexDraft.replace(/^#/, "")}
                spellCheck={false}
                onChange={(e) => applyHexDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === "Enter") {
                    e.preventDefault()
                    const rgb = hexToRgb(hexDraft)
                    onCommit(rgb ? hsvToHex(rgbToHsv(rgb)) : current)
                    ;(e.target as HTMLInputElement).blur()
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    setHexDraft(current)
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                className="w-0 min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[10px] font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/60"
                placeholder="000000"
              />
            </div>
            <button
              type="button"
              title={t("design.props.eyedropper")}
              aria-label={t("design.props.eyedropper")}
              onClick={() => void pickWithEye()}
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Pipette className="size-3.5" />
            </button>
            <button
              type="button"
              title={t("design.props.noColor")}
              aria-label={t("design.props.noColor")}
              onClick={() => onCommit("")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
