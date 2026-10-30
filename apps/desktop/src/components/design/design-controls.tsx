import { useEffect, useState, type ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { ColorPicker } from "./design-color"
import { toHex } from "./design-protocol"

/**
 * Pieces of the properties panel of the design canvas — the visual vocabulary of the
 * Lummia inspector (section with a compact title, field with icon/letter and
 * unit, segmented group with icons), redone over the Orbit design
 * system. Each control edits ONE thing and confirms on leaving the field / Enter:
 * writing on every key would be a write to the file (and an undo step)
 * per letter.
 */

// ------------------------------------------------------------------- values

/** `12px` → `12`; anything else (`1rem`, `50%`, `auto`) stays as it is. */
export const stripPx = (value: string) => value.replace(/^(-?\d+(?:\.\d+)?)px$/i, "$1")

/**
 * What the field typed, as a CSS value: a bare number becomes `px` (unless the
 * property is unitless), empty removes the property.
 */
export function toCssLength(input: string, unitless = false): string {
  const value = input.trim()
  if (!value) return ""
  if (!unitless && /^-?\d+(\.\d+)?$/.test(value)) return `${value}px`
  return value
}

/** The numeric value of a field, or null (`auto`, `1rem`, empty). */
export function numberOf(value: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim())
  return m ? parseFloat(m[1]) : null
}

// ----------------------------------------------------------------- structure

/** Panel section: small semibold title, divider below, `action` on the right. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-border/40 px-3 py-2.5">
      <div className="mb-2 flex h-5 items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold text-foreground/80">{title}</h3>
        {action}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

/** Small label above a field (the `text-[9px]` of Lummia). */
export function SubLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-4 items-center justify-between">
      <span className="text-[9px] font-semibold text-muted-foreground/70">{children}</span>
      {action}
    </div>
  )
}

/** Row of fields side by side, of equal widths. */
export function Fields({ cols = 2, children }: { cols?: 2 | 3; children: ReactNode }) {
  return <div className={cn("grid gap-1.5", cols === 2 ? "grid-cols-2" : "grid-cols-3")}>{children}</div>
}

// ------------------------------------------------------------------ buttons

/** Square icon button with an on state — the on/off of independent sides, aspect ratio lock etc. */
export function ToggleButton({
  active,
  onClick,
  label,
  children,
  className,
}: {
  active?: boolean
  onClick: () => void
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors [&_svg]:size-3",
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border/60 text-muted-foreground/60 hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon: ReactNode
}

/**
 * Segmented group of icons (the layout mode, the text alignment…): a
 * `muted` track with the active item "raised". A `value` outside the options (a
 * value the panel does not know) leaves them all dimmed — showing an active one that
 * is not the real one would lie about the element.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T | null
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={cn("flex w-fit items-center gap-0.5 rounded-lg border border-border/40 bg-muted/30 p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.label}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-7 min-w-7 items-center justify-center rounded-md border px-2 transition-all [&_svg]:size-3.5",
            value === option.value
              ? "border-border/50 bg-background text-foreground shadow-sm"
              : "border-transparent text-muted-foreground/70 hover:text-foreground",
          )}
        >
          {option.icon}
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- fields

/**
 * The shell of every inspector field: 28px of height, always. `flex-auto` (and not
 * `flex-1`) because `flex: 1` is `flex-basis: 0%` — in a flex COLUMN the basis applies
 * to the HEIGHT and cancels the `h-7`, and the field collapses to the height of the text. In the
 * fields inside `Fields` (grid) and the flex rows the `h-7` worked; in the ones that are
 * direct children of a `Section` (column), it did not — that is what made half the
 * panel look squeezed. `min-h-7` holds the height even in a tight column.
 */
const SHELL =
  "flex h-7 min-h-7 min-w-0 flex-auto items-center gap-1.5 rounded-md border border-input bg-input/20 px-1.5 transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30"

/** The same shell for controls that IMITATE a field (the font picker). */
export const FIELD_SHELL = SHELL

const INPUT = "w-0 min-w-0 flex-1 border-0 bg-transparent p-0 text-[10px] font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/60 disabled:text-muted-foreground/40"

/**
 * The lead column: 12px, ALWAYS the same in every field — it is the icon, the
 * color swatch, or nothing (when the field has no icon). It is what makes the
 * values start in the same place across the whole inspector.
 */
const LEAD = "flex size-3 shrink-0 items-center justify-center"

/** Icon (or letter) to the left of the field, dimmed as in Lummia. */
function Lead({ children }: { children: ReactNode }) {
  return <span className={cn(LEAD, "select-none text-[9px] font-bold text-muted-foreground/60 [&_svg]:size-3")}>{children}</span>
}

/**
 * Value field: icon/letter, input, unit. Confirms on Enter or on leaving;
 * Esc goes back to the previous value; ↑/↓ walk 1 by 1 (Shift: 10) when the value is
 * numeric — and they confirm right away, which is what makes the fine adjustment visible on the
 * canvas while the arrow is pressed.
 */
export function Field({
  value,
  placeholder,
  onCommit,
  icon,
  suffix,
  disabled,
  title,
  className,
  step = 1,
  mono,
  trailing,
}: {
  value: string
  placeholder?: string
  onCommit: (value: string) => void
  icon?: ReactNode
  suffix?: string
  disabled?: boolean
  title?: string
  className?: string
  step?: number
  mono?: boolean
  /** Extra control at the end of the field (the Fix/Fill/Hug of the size). */
  trailing?: ReactNode
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = (next = draft) => {
    if (next !== value) onCommit(next)
  }

  return (
    <div className={cn(SHELL, disabled && "opacity-60", className)} title={title}>
      {icon !== undefined ? <Lead>{icon}</Lead> : <span className={LEAD} aria-hidden />}
      <input
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(value)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            const base = numberOf(draft) ?? numberOf(placeholder ?? "") ?? 0
            if (numberOf(draft) === null && draft.trim() !== "") return
            e.preventDefault()
            const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            const next = Math.round((base + delta) * 100) / 100
            const text = String(next)
            setDraft(text)
            commit(text)
          }
        }}
        className={cn(INPUT, mono && "font-mono")}
      />
      {suffix && <span className="shrink-0 select-none text-[9px] text-muted-foreground/60">{suffix}</span>}
      {trailing}
    </div>
  )
}

/**
 * Color: clickable swatch (opens the app picker), value as text and a clear
 * button. The picker is the design one (design-color.tsx), not the system one.
 */
export function ColorField({
  value,
  computed,
  onCommit,
}: {
  value: string
  computed: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const shown = value || computed
  const hex = toHex(shown)
  const commit = (next = draft) => {
    if (next !== value) onCommit(next.trim())
  }
  return (
    <div className={SHELL}>
      {/* The swatch is the lead of the field: 12px, like the icon of the other fields. */}
      <ColorPicker value={value} computed={computed} onCommit={onCommit} />
      <input
        value={draft}
        placeholder={hex ?? computed}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === "Escape") {
            e.preventDefault()
            setDraft(value)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className={cn(INPUT, "font-mono")}
      />
      {value && (
        <button
          type="button"
          aria-label="clear"
          onClick={() => onCommit("")}
          className="flex shrink-0 items-center text-muted-foreground/60 hover:text-foreground [&_svg]:size-3"
        >
          <X />
        </button>
      )}
    </div>
  )
}

/** Free value of a property the panel has no visual control for (font family, shadow…). */
export function TextField(props: Omit<Parameters<typeof Field>[0], "mono">) {
  return <Field {...props} mono />
}
