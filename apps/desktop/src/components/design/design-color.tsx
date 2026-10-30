import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { Pipette, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Hint } from "@/components/ui/hint"
import { hexToRgb, hsvToHex, rgbToHsv, toHex, type Hsv } from "./design-protocol"

/**
 * Color picker of the inspector — in place of the system `<input type="color">`.
 *
 * The native one opens an OS window, outside the app theme, and does not know what the
 * screen palette is. Here the color is chosen in the window itself: the
 * saturation/value area with the cursor, the hue strip, the hex and the eyedropper (the
 * Chromium EyeDropper, when it exists).
 *
 * The choice is confirmed ONCE, at the end of the drag: every write step
 * would be a write to the file (and an undo step) per pixel.
 */

/** The cursor of the saturation/value area: a ring in the chosen color. */
function Cursor({ left, top }: { left: number; top: number }) {
  return (
    <span
      className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
      style={{ left: `${left * 100}%`, top: `${top * 100}%` }}
    />
  )
}

/** Hue strip: the rainbow with the cursor in the chosen color. */
const HUE_BG = "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)"

export function ColorPicker({
  value,
  computed,
  onCommit,
}: {
  /** The value in the element's `style` (what the panel edits). */
  value: string
  /** The computed value — the starting point when there is no value in the `style`. */
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

  /** The canonical value of the current state (the HSV hex). */
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

  /** Drag with the pointer captured: the color moves with the mouse, without going through the key. */
  const drag = (event: ReactPointerEvent, el: HTMLElement, kind: "sv" | "hue") => {
    el.setPointerCapture(event.pointerId)
    fromPointer(event, el, kind)
  }

  const endDrag = (event: ReactPointerEvent, el: HTMLElement) => {
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
    onCommit(hsvToHex(hsv))
  }

  /** Chromium's eyedropper: the color of any pixel on the screen. */
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
      // The user cancelled the selection.
    }
  }

  /** The typed hex: it only enters when it is a real hex. */
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
        // On opening, the value may have changed (the group, the style): the picker
        // is born from what is in effect now.
        if (next) {
          const start = toHex(value || computed) ?? "#000000"
          setHexDraft(start)
          setHsv(rgbToHsv(hexToRgb(start) ?? { r: 0, g: 0, b: 0 }))
        }
      }}
    >
      {/* The swatch IS the trigger: the color the element has (or the checkerboard, when
          it has no color at all). 12px, like the lead of the other fields. */}
      <PopoverTrigger
        title={t("design.props.colorPicker")}
        aria-label={t("design.props.colorPicker")}
        className="box-border size-3 shrink-0 cursor-pointer overflow-hidden rounded-[3px] border border-border/70 transition-transform hover:scale-110"
        style={{
          background: transparent
            ? "repeating-conic-gradient(var(--muted) 0% 25%, var(--background) 0% 50%) 50% / 6px 6px"
            : shown,
        }}
      />
      <PopoverContent align="start" side="bottom" className="w-60 p-2">
        <div className="flex flex-col gap-2">
          {/* Saturation and value: the hue underneath, white on the left and
              black at the bottom. */}
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
            <Hint label={t("design.props.eyedropper")}>
              <button
                type="button"
                aria-label={t("design.props.eyedropper")}
                onClick={() => void pickWithEye()}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/60 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Pipette className="size-3.5" />
              </button>
            </Hint>
            <Hint label={t("design.props.noColor")}>
              <button
                type="button"
                aria-label={t("design.props.noColor")}
                onClick={() => onCommit("")}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/60 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </Hint>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
