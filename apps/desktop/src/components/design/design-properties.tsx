import { useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ALargeSmall,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpLeft,
  ArrowUpToLine,
  Bold,
  Ellipsis,
  Italic,
  LayoutGrid,
  Link2,
  MessageSquarePlus,
  MousePointerClick,
  MoveHorizontal,
  MoveVertical,
  Strikethrough,
  StretchVertical,
  Trash2,
  Type,
  Underline,
  Unlink2,
  X,
} from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { IconAction } from "@/src/components/ai/artifact-part"
import { cn } from "@/lib/utils"
import {
  ColorField,
  Field,
  Fields,
  Section,
  Segmented,
  SubLabel,
  TextField,
  ToggleButton,
  numberOf,
  stripPx,
  toCssLength,
} from "./design-controls"
import type { DesignElementInfo } from "./design-protocol"

/**
 * Painel de propriedades do canvas de design — o inspetor do Figma/Lummia no
 * design system do Orbit: modo de layout em botões, grade de alinhamento 3×3,
 * tamanho com Fix/Fill/Hug e trava de proporção, padding/margem/raio com
 * "lados independentes", tipografia em grupos de ícones, preenchimento e
 * borda com seletor de cor.
 *
 * Cada controle edita propriedades do `style` do elemento (a ponte aplica ao
 * vivo e o painel grava no arquivo). O valor do campo é o INLINE e o cinza é o
 * calculado — dá para ver o que está valendo sem escrever no arquivo o que a
 * pessoa não mexeu. Os controles de lados (padding, margem, raio) mostram o
 * calculado de cada lado, porque um `padding: 10px 18px` e quatro longhands
 * são a mesma coisa para quem olha.
 */

export interface DesignBoardView {
  file: string
  title?: string
  x: number
  y: number
  w: number
  h: number
}

export type DesignPropertiesTarget =
  | { kind: "none"; canvasTitle: string; boards: number }
  | { kind: "board"; board: DesignBoardView }
  | { kind: "element"; board: DesignBoardView; info: DesignElementInfo; depth: number; key: string; count?: number }

interface Props {
  target: DesignPropertiesTarget
  /** Várias propriedades de uma vez (um passo só no arquivo). Valor vazio tira a propriedade. */
  onStyles: (styles: Record<string, string>) => void
  onAttr: (name: string, value: string) => void
  onText: (value: string) => void
  onBoard: (patch: Partial<Pick<DesignBoardView, "title" | "x" | "y" | "w" | "h">>) => void
  onSelectParent: () => void
  onComment: () => void
  onDelete: () => void
}

type Style = (prop: string, value: string) => void

// ------------------------------------------------------------------ ícones

const svg = (children: ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="1 1 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    {children}
  </svg>
)

const BlockIcon = () =>
  svg(
    <>
      <rect x="2" y="2" width="5" height="5" rx="0.5" />
      <rect x="9" y="4" width="5" height="5" rx="0.5" />
      <rect x="4" y="9" width="5" height="5" rx="0.5" />
    </>,
  )
const ColIcon = () =>
  svg(
    <>
      <rect x="5" y="2" width="6" height="3" rx="0.5" />
      <rect x="5" y="6.5" width="6" height="3" rx="0.5" />
      <rect x="5" y="11" width="6" height="3" rx="0.5" />
    </>,
  )
const RowIcon = () =>
  svg(
    <>
      <rect x="2" y="5" width="3" height="6" rx="0.5" />
      <rect x="6.5" y="5" width="3" height="6" rx="0.5" />
      <rect x="11" y="5" width="3" height="6" rx="0.5" />
    </>,
  )
const WrapIcon = () =>
  svg(
    <>
      <rect x="2" y="3" width="3" height="3" rx="0.5" />
      <rect x="7" y="3" width="3" height="3" rx="0.5" />
      <rect x="12" y="3" width="3" height="3" rx="0.5" />
      <rect x="2" y="10" width="3" height="3" rx="0.5" />
      <rect x="7" y="10" width="3" height="3" rx="0.5" />
    </>,
  )
const DashedIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M2 8h3M6.5 8h3M11 8h3" />
  </svg>
)
const SolidIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M2 8h12" />
  </svg>
)
const NoneIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M4 12L12 4" />
  </svg>
)
const gapIcon = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="2" y="2" width="3" height="12" rx="0.5" />
    <rect x="11" y="2" width="3" height="12" rx="0.5" />
    <path d="M6 8h4M6 6.5L4.5 8 6 9.5M10 6.5L11.5 8 10 9.5" strokeWidth="1.4" />
  </svg>
)
const opacityIcon = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <circle cx="8" cy="8" r="6.5" />
    <rect x="4.5" y="4.5" width="3" height="3" fill="currentColor" opacity="0.4" />
    <rect x="8.5" y="8.5" width="3" height="3" fill="currentColor" opacity="0.4" />
  </svg>
)
const radiusIcon = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M2 10V4C2 2.9 2.9 2 4 2H10" />
  </svg>
)
const cornerIcon = (corner: "tl" | "tr" | "br" | "bl") => {
  const d = {
    tl: "M2 10V4C2 2.9 2.9 2 4 2H10",
    tr: "M10 10V4C10 2.9 9.1 2 8 2H2",
    bl: "M2 2V8C2 9.1 2.9 10 4 10H10",
    br: "M10 2V8C10 9.1 9.1 10 8 10H2",
  }[corner]
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d={d} />
    </svg>
  )
}
const independentIcon = (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
    <path d="M3 1H11C12.1 1 13 1.9 13 3V11C13 12.1 12.1 13 11 13H3C1.9 13 1 12.1 1 11V3C1 1.9 1.9 1 3 1Z" stroke="currentColor" strokeWidth="1.2" />
    <path d="M7 1V3M7 11V13M1 7H3M11 7H13" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)
const cornersIcon = (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M1 4C1 2.3 2.3 1 4 1H6M13 4C13 2.3 11.7 1 10 1H8M1 10C1 11.7 2.3 13 4 13H6M13 10C13 11.7 11.7 13 10 13H8" />
  </svg>
)

// ------------------------------------------------------------------ valores

const SIDES = ["top", "right", "bottom", "left"] as const
const CORNERS = [
  { key: "tl", prop: "border-top-left-radius" },
  { key: "tr", prop: "border-top-right-radius" },
  { key: "bl", prop: "border-bottom-left-radius" },
  { key: "br", prop: "border-bottom-right-radius" },
] as const

/** O primeiro token de um valor composto (`8px 8px` → `8px`). */
const first = (value: string) => value.trim().split(/\s+/)[0] ?? ""

/** A primeira cor de um valor composto (`rgb(1, 2, 3) rgb(…)` → `rgb(1, 2, 3)`). */
function firstColor(value: string): string {
  const m = /^(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)/i.exec(value.trim())
  return m ? m[1] : value.trim()
}

type Axis = "start" | "center" | "end"
const FLEX_AXIS: Record<string, Axis> = {
  "flex-start": "start",
  start: "start",
  normal: "start",
  left: "start",
  center: "center",
  "flex-end": "end",
  end: "end",
  right: "end",
}
const AXIS_VALUE: Record<Axis, string> = { start: "flex-start", center: "center", end: "flex-end" }

type LayoutMode = "block" | "col" | "row" | "wrap" | "grid"

const SHADOWS = {
  soft: "0 1px 2px rgba(0, 0, 0, 0.12)",
  medium: "0 4px 12px rgba(0, 0, 0, 0.18)",
  strong: "0 12px 32px rgba(0, 0, 0, 0.28)",
} as const

/**
 * Forma canônica de uma sombra, para comparar com os presets: o navegador
 * devolve o inline normalizado (`rgba(0, 0, 0, 0.18) 0px 4px 12px`, cor
 * primeiro e `0px` explícito), diferente do que o preset escreve.
 */
function canonShadow(value: string): string {
  const color = /rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}/i.exec(value)?.[0] ?? ""
  const rest = value.replace(color, "").replace(/\b0px\b/g, "0").replace(/\s+/g, " ").trim()
  return `${color.replace(/\s+/g, "")}|${rest}`
}

type Sizing = "fixed" | "fill" | "hug"
const sizingOf = (inline: string): Sizing => (inline === "100%" ? "fill" : inline === "fit-content" ? "hug" : "fixed")

// ------------------------------------------------------------------ peças locais

function SelectInShell({
  value,
  options,
  onChange,
  className,
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  className?: string
}) {
  const current = options.find((option) => option.value === value)
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(String(next))}>
      <SelectTrigger
        size="sm"
        className={cn("h-5 w-auto gap-0.5 border-0 bg-transparent px-1 text-[10px] hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent", className)}
      >
        <SelectValue>{current?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SelectField({
  value,
  placeholder,
  options,
  onCommit,
}: {
  value: string
  placeholder: string
  options: string[]
  onCommit: (value: string) => void
}) {
  const UNSET = "__unset"
  return (
    <Select value={value || UNSET} onValueChange={(next) => next !== null && onCommit(next === UNSET ? "" : String(next))}>
      <SelectTrigger size="sm" className="h-7 w-full min-w-0 flex-1 font-mono text-[10px] font-semibold">
        <SelectValue>{value || <span className="font-normal text-muted-foreground">{placeholder}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>
          <span className="text-muted-foreground">—</span>
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Grade 3×3 de alinhamento (a do Lummia): o ponto ativo é a posição do conteúdo no contêiner flex. */
function AlignGrid({
  isCol,
  justify,
  items,
  spaceBetween,
  onChange,
  onToggleSpace,
  label,
}: {
  isCol: boolean
  justify: Axis | null
  items: Axis | null
  spaceBetween: boolean
  onChange: (vertical: Axis, horizontal: Axis) => void
  onToggleSpace: () => void
  label: string
}) {
  // No eixo principal o que vale é o `justify`; no cruzado, o `items`.
  const horizontal = isCol ? items : justify
  const vertical = isCol ? justify : items
  const axes: Axis[] = ["start", "center", "end"]
  return (
    <div
      title={label}
      onDoubleClick={onToggleSpace}
      className={cn(
        "grid size-14 shrink-0 cursor-pointer select-none grid-cols-3 grid-rows-3 gap-0.5 rounded-lg border bg-muted/10 p-1 transition-colors",
        spaceBetween ? "border-primary/40 bg-primary/[0.04]" : "border-border/60",
      )}
    >
      {axes.map((v) =>
        axes.map((h) => {
          const active = spaceBetween
            ? isCol
              ? horizontal === h
              : vertical === v
            : vertical === v && horizontal === h
          return (
            <button
              key={`${v}-${h}`}
              type="button"
              aria-label={`${v} ${h}`}
              onClick={() => onChange(v, h)}
              className="flex size-full items-center justify-center rounded transition-colors hover:bg-accent/40"
            >
              {active ? <span className="size-1.5 rounded-sm bg-primary" /> : <span className="size-1 rounded-full bg-muted-foreground/25" />}
            </button>
          )
        }),
      )}
    </div>
  )
}

/**
 * Padding ou margem: um par X/Y (os lados ligados) ou os quatro lados
 * independentes, como no Lummia. O estado inicial é "independente" quando os
 * lados não são simétricos — ligar de novo seria perder um valor.
 */
function SpacingBox({
  kind,
  title,
  info,
  onStyles,
}: {
  kind: "padding" | "margin"
  title: string
  info: DesignElementInfo
  onStyles: (styles: Record<string, string>) => void
}) {
  const { t } = useTranslation()
  const sides = Object.fromEntries(SIDES.map((side) => [side, stripPx(info.computed[`${kind}-${side}`] ?? "")])) as Record<(typeof SIDES)[number], string>
  const symmetric = sides.top === sides.bottom && sides.left === sides.right
  const [independent, setIndependent] = useState(!symmetric)

  const write = (next: Record<(typeof SIDES)[number], string>, asIndependent: boolean) => {
    const css = (value: string) => toCssLength(value || "0")
    if (asIndependent) {
      onStyles({
        [kind]: "",
        ...Object.fromEntries(SIDES.map((side) => [`${kind}-${side}`, css(next[side])])),
      })
      return
    }
    const y = css(next.top)
    const x = css(next.left)
    // A ordem importa: no CSSOM o shorthand EXPANDE para os longhands, então
    // apagar "padding-top" depois de pôr "padding" desfaria o próprio valor.
    // Os longhands vão primeiro, o shorthand por último.
    onStyles({
      ...Object.fromEntries(SIDES.map((side) => [`${kind}-${side}`, ""])),
      [kind]: y === x ? y : `${y} ${x}`,
    })
  }

  const setSide = (side: (typeof SIDES)[number], value: string) => {
    const next = { ...sides, [side]: value }
    if (!independent) {
      // Ligados: X vale para os dois lados horizontais, Y para os verticais.
      if (side === "left" || side === "right") {
        next.left = value
        next.right = value
      } else {
        next.top = value
        next.bottom = value
      }
    }
    write(next, independent)
  }

  const icons = {
    top: <ArrowUpToLine />,
    right: <ArrowRightToLine />,
    bottom: <ArrowDownToLine />,
    left: <ArrowLeftToLine />,
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border/30 pt-2">
      <SubLabel
        action={
          <ToggleButton
            active={independent}
            label={t("design.props.independentSides")}
            className="size-5"
            onClick={() => {
              const next = !independent
              setIndependent(next)
              // Ao desligar, os lados passam a ser o par X (esquerda) / Y (cima).
              if (!next) write(sides, false)
            }}
          >
            {independentIcon}
          </ToggleButton>
        }
      >
        {title}
      </SubLabel>
      {independent ? (
        <Fields>
          {(["left", "top", "right", "bottom"] as const).map((side) => (
            <Field key={side} icon={icons[side]} value={sides[side]} suffix="px" onCommit={(v) => setSide(side, v)} />
          ))}
        </Fields>
      ) : (
        <Fields>
          <Field icon={<MoveHorizontal />} value={sides.left} suffix="px" title="X" onCommit={(v) => setSide("left", v)} />
          <Field icon={<MoveVertical />} value={sides.top} suffix="px" title="Y" onCommit={(v) => setSide("top", v)} />
        </Fields>
      )}
    </div>
  )
}

/** Raio: um valor para os quatro cantos, ou um por canto. */
function RadiusField({
  info,
  onStyles,
  label,
  mixed,
}: {
  info: DesignElementInfo
  onStyles: (styles: Record<string, string>) => void
  label: string
  /** Propriedades com valores diferentes no grupo selecionado ("Misto"). */
  mixed?: Set<string>
}) {
  const { t } = useTranslation()
  const corners = Object.fromEntries(
    CORNERS.map((c) => [c.key, mixed?.has(c.prop) ? "" : stripPx(first(info.computed[c.prop] ?? ""))]),
  ) as Record<(typeof CORNERS)[number]["key"], string>
  const same = corners.tl === corners.tr && corners.tr === corners.br && corners.br === corners.bl
  const [independent, setIndependent] = useState(!same)
  const radiusMixed = Boolean(mixed?.has("border-radius")) || CORNERS.some((c) => mixed?.has(c.prop))

  const writeAll = (value: string) => {
    onStyles({ "border-radius": toCssLength(value || "0"), ...Object.fromEntries(CORNERS.map((c) => [c.prop, ""])) })
  }
  const writeCorner = (key: (typeof CORNERS)[number]["key"], value: string) => {
    const next = { ...corners, [key]: value }
    onStyles({
      "border-radius": "",
      ...Object.fromEntries(CORNERS.map((c) => [c.prop, toCssLength(next[c.key] || "0")])),
    })
  }

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <SubLabel>{label}</SubLabel>
        <div className="flex items-center gap-1">
          <Field
            icon={radiusIcon}
            value={independent ? (same ? corners.tl : "") : corners.tl}
            placeholder={radiusMixed || (independent && !same) ? t("design.props.mixed") : "0"}
            suffix="px"
            onCommit={writeAll}
          />
          <ToggleButton active={independent} label={t("design.props.independentCorners")} onClick={() => setIndependent((v) => !v)}>
            {cornersIcon}
          </ToggleButton>
        </div>
      </div>
      {independent && (
        <div className="col-span-2">
          <Fields>
            {CORNERS.map((c) => (
              <Field key={c.key} icon={cornerIcon(c.key)} value={corners[c.key]} suffix="px" onCommit={(v) => writeCorner(c.key, v)} />
            ))}
          </Fields>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ painel

export function DesignProperties({ target, onStyles, onAttr, onText, onBoard, onSelectParent, onComment, onDelete }: Props) {
  const { t } = useTranslation()
  const [lockRatio, setLockRatio] = useState(false)
  const elementKey = target.kind === "element" ? target.key : ""
  useEffect(() => setLockRatio(false), [elementKey])

  if (target.kind === "none") {
    return (
      <div className="flex flex-col gap-2 px-3 py-3">
        <p className="text-[11px] font-semibold text-foreground">{target.canvasTitle}</p>
        <p className="text-[11px] text-muted-foreground">{t("design.boardsCount", { count: target.boards })}</p>
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <MousePointerClick className="mt-0.5 size-3 shrink-0" />
          {t("design.noSelection")}
        </p>
      </div>
    )
  }

  if (target.kind === "board") {
    const { board } = target
    const num = (key: "x" | "y" | "w" | "h") => (value: string) => {
      const n = numberOf(value)
      if (n !== null) onBoard({ [key]: n })
    }
    return (
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <LayoutGrid className="size-3.5 shrink-0 text-primary" />
            <span className="truncate text-xs font-medium">{board.title ?? board.file}</span>
          </div>
          <IconAction icon={MessageSquarePlus} label={t("design.comment")} onClick={onComment} />
        </div>
        <Section title={t("design.props.artboard")}>
          <div className="flex flex-col gap-1">
            <SubLabel>{t("design.props.title")}</SubLabel>
            <TextField value={board.title ?? ""} placeholder={board.file} onCommit={(v) => onBoard({ title: v })} />
          </div>
          <Fields>
            <div className="flex flex-col gap-1">
              <SubLabel>{t("design.props.width")}</SubLabel>
              <Field icon="W" value={String(board.w)} suffix="px" onCommit={num("w")} />
            </div>
            <div className="flex flex-col gap-1">
              <SubLabel>{t("design.props.height")}</SubLabel>
              <Field icon="H" value={String(board.h)} suffix="px" onCommit={num("h")} />
            </div>
          </Fields>
          <Fields>
            <div className="flex flex-col gap-1">
              <SubLabel>X</SubLabel>
              <Field icon="X" value={String(board.x)} suffix="px" onCommit={num("x")} />
            </div>
            <div className="flex flex-col gap-1">
              <SubLabel>Y</SubLabel>
              <Field icon="Y" value={String(board.y)} suffix="px" onCommit={num("y")} />
            </div>
          </Fields>
        </Section>
        <p className="px-3 py-2 text-[11px] text-muted-foreground">{t("design.boardHint")}</p>
      </div>
    )
  }

  const { info } = target
  const style: Style = (prop, value) => onStyles({ [prop]: value })
  /**
   * "Misto": a propriedade tem valores DIFERENTES entre os elementos
   * selecionados. O campo fica vazio e mostra o aviso no lugar do valor (como
   * no Figma) — e o que o usuário digitar vale para todos eles.
   */
  const mixedProps = new Set(info.mixed ?? [])
  const mixedAttrs = new Set(info.mixedAttrs ?? [])
  const isMixed = (prop: string) => mixedProps.has(prop)
  const inline = (prop: string) => (isMixed(prop) ? "" : (info.inline[prop] ?? ""))
  const computed = (prop: string) => (isMixed(prop) ? t("design.props.mixed") : (info.computed[prop] ?? ""))
  const either = (prop: string) => (isMixed(prop) ? "" : (inline(prop) || computed(prop)))

  // ----- layout
  const display = either("display")
  const isFlex = display.includes("flex")
  const isGrid = display.includes("grid")
  const direction = either("flex-direction")
  const isCol = direction.startsWith("column")
  const wraps = either("flex-wrap").startsWith("wrap")
  const mode: LayoutMode | null = isMixed("display")
    ? null
    : isGrid
      ? "grid"
      : isFlex
        ? wraps
          ? "wrap"
          : isCol
            ? "col"
            : "row"
        : "block"
  const justifyRaw = either("justify-content")
  const spaceBetween = justifyRaw === "space-between"
  const justify = FLEX_AXIS[justifyRaw] ?? null
  // `align-items: normal` é "esticar" — nenhum dos nove pontos é o real.
  const itemsRaw = either("align-items")
  const items = itemsRaw === "normal" || itemsRaw === "stretch" ? null : (FLEX_AXIS[itemsRaw] ?? null)

  const setMode = (next: LayoutMode) => {
    if (next === "block") onStyles({ display: "block", "flex-direction": "", "flex-wrap": "" })
    else if (next === "grid") onStyles({ display: "grid", "flex-direction": "", "flex-wrap": "" })
    else if (next === "col") onStyles({ display: "flex", "flex-direction": "column", "flex-wrap": "" })
    else if (next === "row") onStyles({ display: "flex", "flex-direction": "row", "flex-wrap": "" })
    else onStyles({ display: "flex", "flex-direction": "row", "flex-wrap": "wrap" })
  }

  const setAlignment = (vertical: Axis, horizontal: Axis) => {
    const main = isCol ? vertical : horizontal
    const cross = isCol ? horizontal : vertical
    onStyles({
      "align-items": AXIS_VALUE[cross],
      "justify-content": spaceBetween ? "space-between" : AXIS_VALUE[main],
    })
  }

  const toggleSpace = () => onStyles(spaceBetween ? { "justify-content": "flex-start" } : { "justify-content": "space-between", gap: "" })

  // ----- tamanho
  const widthKind = sizingOf(inline("width"))
  const heightKind = sizingOf(inline("height"))
  const rect = info.rect
  const ratio = rect && rect.h > 0 ? rect.w / rect.h : 1
  const sizeOptions = [
    { value: "fixed", label: t("design.props.sizing.fixed") },
    { value: "fill", label: t("design.props.sizing.fill") },
    { value: "hug", label: t("design.props.sizing.hug") },
  ]
  const setSize = (dimension: "width" | "height", kind: Sizing) => {
    if (kind === "fill") return style(dimension, "100%")
    if (kind === "hug") return style(dimension, "fit-content")
    const px = Math.round(numberOf(computed(dimension)) ?? (dimension === "width" ? (rect?.w ?? 100) : (rect?.h ?? 100)))
    style(dimension, `${px}px`)
  }
  const commitSize = (dimension: "width" | "height", value: string) => {
    const css = toCssLength(value)
    const n = numberOf(css)
    if (lockRatio && n !== null && widthKind === "fixed" && heightKind === "fixed") {
      const other = dimension === "width" ? Math.round(n / ratio) : Math.round(n * ratio)
      onStyles({ [dimension]: css, [dimension === "width" ? "height" : "width"]: `${other}px` })
      return
    }
    style(dimension, css)
  }
  const sizeField = (dimension: "width" | "height", letter: string, kind: Sizing) => (
    <Field
      icon={letter}
      disabled={kind !== "fixed"}
      value={kind === "fill" ? t("design.props.sizing.fill") : kind === "hug" ? t("design.props.sizing.hug") : stripPx(inline(dimension))}
      placeholder={stripPx(computed(dimension))}
      onCommit={(v) => commitSize(dimension, v)}
      trailing={<SelectInShell value={kind} options={sizeOptions} onChange={(next) => setSize(dimension, next as Sizing)} />}
    />
  )

  // ----- posição
  const position = either("position")
  const gap = isGrid || isFlex ? inline("gap") : ""

  // ----- tipografia
  const showType = info.kind !== "image" && info.kind !== "svg"
  const weight = either("font-weight")
  const italic = either("font-style") === "italic"
  const decoration = either("text-decoration-line")
  const textAlign = ((): "left" | "center" | "right" | "justify" | null => {
    const v = either("text-align")
    if (v === "start") return "left"
    if (v === "end") return "right"
    return v === "left" || v === "center" || v === "right" || v === "justify" ? v : null
  })()
  const toggleDecoration = (line: "underline" | "line-through") => {
    const lines = new Set(decoration.split(/\s+/).filter((l) => l && l !== "none"))
    if (lines.has(line)) lines.delete(line)
    else lines.add(line)
    style("text-decoration", lines.size ? [...lines].join(" ") : "none")
  }

  // ----- aparência
  const opacityPercent = (() => {
    const raw = inline("opacity") || computed("opacity")
    const n = parseFloat(raw)
    return Number.isFinite(n) ? String(Math.round(n * 100)) : ""
  })()
  const commitOpacity = (value: string) => {
    const n = parseFloat(value.replace("%", ""))
    if (!value.trim() || !Number.isFinite(n)) return style("opacity", "")
    style("opacity", n >= 100 ? "" : String(Math.max(0, n) / 100))
  }

  // ----- borda
  const borderStyle = ((): "solid" | "dashed" | "dotted" | "none" => {
    const v = either("border-style")
    return v === "solid" || v === "dashed" || v === "dotted" ? v : "none"
  })()
  const borderWidth = stripPx(first(either("border-width")))
  const borderColor = firstColor(inline("border-color") || computed("border-color"))
  /** Dar cor ou espessura a uma borda "none" é querer ver a borda: vira sólida. */
  const withVisibleBorder = (styles: Record<string, string>) =>
    onStyles(borderStyle === "none" && !("border-style" in styles) ? { ...styles, "border-style": "solid" } : styles)

  const shadow = inline("box-shadow")
  const shadowPreset = (Object.entries(SHADOWS).find(([, v]) => canonShadow(v) === canonShadow(shadow))?.[0] ?? (shadow && shadow !== "none" ? "custom" : "none")) as
    | "none"
    | "custom"
    | keyof typeof SHADOWS

  return (
    <div className="flex flex-col">
      {/* Cabeçalho do elemento: tag + nome à esquerda, ações à direita. */}
      <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{info.tag}</span>
          <span className="truncate text-xs font-medium">{info.label || (info.text ?? "").trim().slice(0, 40) || info.tag}</span>
          {/* Mais de um selecionado: o painel edita TODOS eles. */}
          {target.count && target.count > 1 && (
            <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {target.count}×
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {target.depth > 1 && <IconAction icon={ArrowUpLeft} label={t("design.selectParent")} onClick={onSelectParent} />}
          <IconAction icon={MessageSquarePlus} label={t("design.comment")} onClick={onComment} />
          <IconAction icon={Trash2} label={t("design.delete")} onClick={onDelete} />
        </div>
      </div>

      {info.kind === "text" && info.text !== null && (
        <Section title={t("design.props.content")}>
          <TextContent
            value={info.mixedText ? "" : info.text}
            placeholder={info.mixedText ? t("design.props.mixed") : undefined}
            onCommit={onText}
          />
          <p className="text-[10px] text-muted-foreground">{t("design.editHint")}</p>
        </Section>
      )}

      {/* Layout: modo em botões, tamanho com Fix/Fill/Hug, alinhamento, espaçamentos. */}
      <Section title={t("design.props.layout")}>
        <Segmented<LayoutMode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "block", label: t("design.props.mode.block"), icon: <BlockIcon /> },
            { value: "col", label: t("design.props.mode.col"), icon: <ColIcon /> },
            { value: "row", label: t("design.props.mode.row"), icon: <RowIcon /> },
            { value: "wrap", label: t("design.props.mode.wrap"), icon: <WrapIcon /> },
            { value: "grid", label: t("design.props.mode.grid"), icon: <LayoutGrid /> },
          ]}
        />

        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">{sizeField("width", "W", widthKind)}</div>
          <ToggleButton active={lockRatio} label={t(lockRatio ? "design.props.unlockRatio" : "design.props.lockRatio")} onClick={() => setLockRatio((v) => !v)}>
            {lockRatio ? <Link2 /> : <Unlink2 />}
          </ToggleButton>
          <div className="min-w-0 flex-1">{sizeField("height", "H", heightKind)}</div>
        </div>

        {isFlex && (
          <div className="flex items-start gap-3 border-t border-border/30 pt-2">
            <AlignGrid
              isCol={isCol}
              justify={justify}
              items={items}
              spaceBetween={spaceBetween}
              onChange={setAlignment}
              onToggleSpace={toggleSpace}
              label={t("design.props.alignHint")}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Field
                icon={gapIcon}
                disabled={spaceBetween}
                value={spaceBetween ? t("design.props.auto") : stripPx(gap)}
                placeholder={stripPx(first(computed("gap")))}
                title={t("design.props.gap")}
                onCommit={(v) => style("gap", toCssLength(v))}
                trailing={
                  <button
                    type="button"
                    onClick={toggleSpace}
                    title={t("design.props.spaceBetween")}
                    className={cn(
                      "flex h-4 shrink-0 items-center rounded px-1.5 text-[8px] font-bold transition-colors",
                      spaceBetween ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground/60 hover:text-foreground",
                    )}
                  >
                    {spaceBetween ? "auto" : "px"}
                  </button>
                }
              />
            </div>
          </div>
        )}

        {isGrid && (
          <div className="flex flex-col gap-1 border-t border-border/30 pt-2">
            <SubLabel>{t("design.props.columns")}</SubLabel>
            <TextField
              icon={<Columns />}
              value={inline("grid-template-columns")}
              placeholder={computed("grid-template-columns")}
              onCommit={(v) => style("grid-template-columns", v)}
            />
            <Field
              icon={gapIcon}
              value={stripPx(gap)}
              placeholder={stripPx(first(computed("gap")))}
              suffix="px"
              title={t("design.props.gap")}
              onCommit={(v) => style("gap", toCssLength(v))}
            />
          </div>
        )}

        <SpacingBox key={`p:${elementKey}`} kind="padding" title={t("design.props.padding")} info={info} onStyles={onStyles} />
        <SpacingBox key={`m:${elementKey}`} kind="margin" title={t("design.props.margin")} info={info} onStyles={onStyles} />

        <label className="flex w-fit cursor-pointer select-none items-center gap-1.5 border-t border-border/30 pt-2">
          <input
            type="checkbox"
            checked={either("overflow") === "hidden"}
            onChange={(e) => style("overflow", e.target.checked ? "hidden" : "")}
            className="size-3 rounded border-input accent-primary"
          />
          <span className="text-[10px] font-medium text-foreground/70">{t("design.props.clip")}</span>
        </label>
      </Section>

      {/* Posição: só pede X/Y quando o elemento sai do fluxo. */}
      <Section title={t("design.props.position")}>
        <SelectField
          value={inline("position")}
          placeholder={computed("position")}
          options={["static", "relative", "absolute", "fixed", "sticky"]}
          onCommit={(v) => style("position", v)}
        />
        {position !== "static" && (
          <Fields>
            <Field icon="X" value={stripPx(inline("left"))} placeholder={stripPx(computed("left"))} suffix="px" onCommit={(v) => style("left", toCssLength(v))} />
            <Field icon="Y" value={stripPx(inline("top"))} placeholder={stripPx(computed("top"))} suffix="px" onCommit={(v) => style("top", toCssLength(v))} />
          </Fields>
        )}
        {position !== "static" && (
          <Field icon="Z" value={inline("z-index")} placeholder={computed("z-index")} title="z-index" onCommit={(v) => style("z-index", v.trim())} />
        )}
      </Section>

      {showType && (
        <Section title={t("design.props.typography")}>
          <TextField icon={<Type />} value={inline("font-family")} placeholder={first(computed("font-family")).replace(/["']/g, "")} onCommit={(v) => style("font-family", v)} />
          <Fields>
            <Field
              icon={<ALargeSmall />}
              value={stripPx(inline("font-size"))}
              placeholder={stripPx(computed("font-size"))}
              suffix="px"
              title={t("design.props.fontSize")}
              onCommit={(v) => style("font-size", toCssLength(v))}
            />
            <SelectField
              value={inline("font-weight")}
              placeholder={weight}
              options={["300", "400", "500", "600", "700", "800", "900"]}
              onCommit={(v) => style("font-weight", v)}
            />
          </Fields>
          <Fields>
            <Field
              icon={<StretchVertical />}
              value={inline("line-height")}
              placeholder={computed("line-height")}
              title={t("design.props.lineHeight")}
              onCommit={(v) => style("line-height", v.trim())}
            />
            <Field
              icon={<MoveHorizontal />}
              value={stripPx(inline("letter-spacing"))}
              placeholder={stripPx(computed("letter-spacing"))}
              title={t("design.props.letterSpacing")}
              onCommit={(v) => style("letter-spacing", toCssLength(v))}
            />
          </Fields>
          <div className="flex flex-wrap items-center gap-1.5">
            <Segmented
              value={textAlign}
              onChange={(v) => style("text-align", v)}
              options={[
                { value: "left", label: t("design.props.alignOpt.left"), icon: <AlignLeft /> },
                { value: "center", label: t("design.props.alignOpt.center"), icon: <AlignCenter /> },
                { value: "right", label: t("design.props.alignOpt.right"), icon: <AlignRight /> },
                { value: "justify", label: t("design.props.alignOpt.justify"), icon: <AlignJustify /> },
              ]}
            />
            <div className="flex items-center gap-1">
              <ToggleButton active={Number(weight) >= 600} label={t("design.props.style.bold")} onClick={() => style("font-weight", Number(weight) >= 600 ? "400" : "700")}>
                <Bold />
              </ToggleButton>
              <ToggleButton active={italic} label={t("design.props.style.italic")} onClick={() => style("font-style", italic ? "" : "italic")}>
                <Italic />
              </ToggleButton>
              <ToggleButton active={decoration.includes("underline")} label={t("design.props.style.underline")} onClick={() => toggleDecoration("underline")}>
                <Underline />
              </ToggleButton>
              <ToggleButton active={decoration.includes("line-through")} label={t("design.props.style.strike")} onClick={() => toggleDecoration("line-through")}>
                <Strikethrough />
              </ToggleButton>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <SubLabel>{t("design.props.color")}</SubLabel>
            <ColorField value={inline("color")} computed={computed("color")} onCommit={(v) => style("color", v)} />
          </div>
        </Section>
      )}

      <Section title={t("design.props.appearance")}>
        <Fields>
          <div className="flex min-w-0 flex-col gap-1">
            <SubLabel>{t("design.props.opacity")}</SubLabel>
            <Field
              icon={opacityIcon}
              value={opacityPercent === "100" ? "" : opacityPercent}
              placeholder={isMixed("opacity") ? t("design.props.mixed") : "100"}
              suffix="%"
              onCommit={commitOpacity}
            />
          </div>
          <RadiusField info={info} onStyles={onStyles} label={t("design.props.radius")} mixed={mixedProps} />
        </Fields>
      </Section>

      <Section title={t("design.props.fill")}>
        <ColorField value={inline("background-color")} computed={computed("background-color")} onCommit={(v) => style("background-color", v)} />
        <div className="flex flex-col gap-1">
          <SubLabel>{t("design.props.background")}</SubLabel>
          {/* Só gradiente/imagem: uma cor lisa já é o campo de cima (o inline
              `background: #fff` apareceria aqui como `rgb(255, 255, 255)`). */}
          <TextField
            value={/gradient|url\(/i.test(inline("background")) ? inline("background") : ""}
            placeholder="linear-gradient(…) / url(…)"
            onCommit={(v) => style("background", v)}
          />
        </div>
      </Section>

      <Section title={t("design.props.stroke")}>
        <ColorField
          value={inline("border-color")}
          computed={borderColor}
          onCommit={(v) => withVisibleBorder({ "border-color": v })}
        />
        <div className="flex items-center gap-1.5">
          <Field
            icon={<Ellipsis />}
            value={stripPx(first(inline("border-width")))}
            placeholder={borderWidth}
            suffix="px"
            title={t("design.props.strokeWidth")}
            onCommit={(v) => withVisibleBorder({ "border-width": toCssLength(v) })}
          />
          <Segmented
            value={borderStyle}
            // Estilo sem espessura não desenha nada: escolher um dá 1px junto.
            onChange={(v) =>
              v !== "none" && (numberOf(borderWidth) ?? 0) === 0 ? onStyles({ "border-style": v, "border-width": "1px" }) : style("border-style", v)
            }
            options={[
              { value: "solid", label: t("design.props.strokeStyle.solid"), icon: <SolidIcon /> },
              { value: "dashed", label: t("design.props.strokeStyle.dashed"), icon: <DashedIcon /> },
              { value: "dotted", label: t("design.props.strokeStyle.dotted"), icon: <Ellipsis /> },
              { value: "none", label: t("design.props.strokeStyle.none"), icon: <NoneIcon /> },
            ]}
          />
        </div>
      </Section>

      <Section title={t("design.props.effects")}>
        <Segmented
          value={shadowPreset === "custom" ? null : shadowPreset}
          onChange={(v) => style("box-shadow", v === "none" ? "" : SHADOWS[v])}
          options={[
            { value: "none", label: t("design.props.shadowPreset.none"), icon: <X /> },
            { value: "soft", label: t("design.props.shadowPreset.soft"), icon: <span className="text-[10px] font-semibold">S</span> },
            { value: "medium", label: t("design.props.shadowPreset.medium"), icon: <span className="text-[10px] font-semibold">M</span> },
            { value: "strong", label: t("design.props.shadowPreset.strong"), icon: <span className="text-[10px] font-semibold">L</span> },
          ]}
        />
        <TextField value={shadow} placeholder="0 4px 12px rgba(0, 0, 0, 0.2)" title={t("design.props.shadow")} onCommit={(v) => style("box-shadow", v)} />
      </Section>

      <Section title={t("design.props.attributes")}>
        {(["id", "class", ...(["src", "href", "alt"] as const).filter((name) => name in info.attrs)] as string[]).map((name) => (
          <div key={name} className="flex flex-col gap-1">
            <SubLabel>{name}</SubLabel>
            <TextField
              value={mixedAttrs.has(name) ? "" : (info.attrs[name] ?? "")}
              placeholder={mixedAttrs.has(name) ? t("design.props.mixed") : undefined}
              onCommit={(v) => onAttr(name, v)}
            />
          </div>
        ))}
        <div className="flex flex-col gap-1">
          <SubLabel>{t("design.props.css")}</SubLabel>
          <CssBox value={info.attrs.style ?? ""} onCommit={(v) => onAttr("style", v)} />
        </div>
      </Section>
    </div>
  )
}

function Columns() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M6 2v12M10 2v12" />
    </svg>
  )
}

/** O `style` inteiro do elemento, para quem prefere escrever CSS (o RawClasses do Lummia). */
function CssBox({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Textarea
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          if (draft !== value) onCommit(draft)
        }
        e.stopPropagation()
      }}
      rows={3}
      className="min-h-14 font-mono text-[10px]"
    />
  )
}

function TextContent({ value, onCommit, placeholder }: { value: string; onCommit: (value: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Textarea
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          if (draft !== value) onCommit(draft)
        }
        e.stopPropagation()
      }}
      rows={2}
      className="min-h-12 text-[11px]"
    />
  )
}
