import { useEffect, useState, type ReactNode } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { ColorPicker } from "./design-color"
import { toHex } from "./design-protocol"

/**
 * Peças do painel de propriedades do canvas de design — o vocabulário visual do
 * inspetor do Lummia (seção com título compacto, campo com ícone/letra e
 * unidade, grupo segmentado com ícones), refeito sobre o design system do
 * Orbit. Cada controle edita UMA coisa e confirma ao sair do campo / Enter:
 * escrever a cada tecla seria uma escrita no arquivo (e um passo de desfazer)
 * por letra.
 */

// ------------------------------------------------------------------ valores

/** `12px` → `12`; qualquer outra coisa (`1rem`, `50%`, `auto`) fica como está. */
export const stripPx = (value: string) => value.replace(/^(-?\d+(?:\.\d+)?)px$/i, "$1")

/**
 * O que o campo digitou, como valor de CSS: número puro vira `px` (a menos que a
 * propriedade seja sem unidade), vazio tira a propriedade.
 */
export function toCssLength(input: string, unitless = false): string {
  const value = input.trim()
  if (!value) return ""
  if (!unitless && /^-?\d+(\.\d+)?$/.test(value)) return `${value}px`
  return value
}

/** O valor numérico de um campo, ou null (`auto`, `1rem`, vazio). */
export function numberOf(value: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim())
  return m ? parseFloat(m[1]) : null
}

// ------------------------------------------------------------------ estrutura

/** Seção do painel: título pequeno e semibold, divisor embaixo, `action` à direita. */
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

/** Rótulo pequeno acima de um campo (o `text-[9px]` do Lummia). */
export function SubLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-4 items-center justify-between">
      <span className="text-[9px] font-semibold text-muted-foreground/70">{children}</span>
      {action}
    </div>
  )
}

/** Linha de campos lado a lado, de larguras iguais. */
export function Fields({ cols = 2, children }: { cols?: 2 | 3; children: ReactNode }) {
  return <div className={cn("grid gap-1.5", cols === 2 ? "grid-cols-2" : "grid-cols-3")}>{children}</div>
}

// ------------------------------------------------------------------ botões

/** Botão quadrado de ícone com estado ligado — o liga/desliga de lados independentes, trava de proporção etc. */
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
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors [&_svg]:size-3",
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
 * Grupo segmentado de ícones (o modo de layout, o alinhamento de texto…): um
 * trilho `muted` com o item ativo "levantado". `value` fora das opções (um
 * valor que o painel não conhece) deixa todos apagados — mostrar um ativo que
 * não é o real seria mentir sobre o elemento.
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
          title={option.label}
          aria-label={option.label}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex h-6 min-w-7 items-center justify-center rounded-md border px-2 transition-all [&_svg]:size-3.5",
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

// ------------------------------------------------------------------ campos

const SHELL =
  "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input bg-input/20 px-1.5 transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30"

const INPUT = "w-0 min-w-0 flex-1 border-0 bg-transparent p-0 text-[10px] font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/60 disabled:text-muted-foreground/40"

/** Ícone (ou letra) à esquerda do campo, apagado como no Lummia. */
function Lead({ children }: { children: ReactNode }) {
  return <span className="flex shrink-0 select-none items-center text-[9px] font-bold text-muted-foreground/60 [&_svg]:size-3">{children}</span>
}

/**
 * Campo de valor: ícone/letra, entrada, unidade. Confirma no Enter ou ao sair;
 * Esc volta ao valor anterior; ↑/↓ andam de 1 em 1 (Shift: 10) quando o valor é
 * numérico — e confirmam na hora, que é o que faz o ajuste fino ser visível no
 * canvas enquanto se aperta a seta.
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
  /** Controle extra no fim do campo (o Fix/Fill/Hug do tamanho). */
  trailing?: ReactNode
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = (next = draft) => {
    if (next !== value) onCommit(next)
  }

  return (
    <div className={cn(SHELL, disabled && "opacity-60", className)} title={title}>
      {icon !== undefined && <Lead>{icon}</Lead>}
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
 * Cor: amostra clicável (abre o seletor do app), valor em texto e botão de
 * limpar. O seletor é o do design (design-color.tsx), não o do sistema.
 */
export function ColorField({
  value,
  computed,
  onCommit,
  icon,
}: {
  value: string
  computed: string
  onCommit: (value: string) => void
  icon?: ReactNode
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
      {icon !== undefined && <Lead>{icon}</Lead>}
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

/** Valor livre de uma propriedade que o painel não tem controle visual para (família da fonte, sombra…). */
export function TextField(props: Omit<Parameters<typeof Field>[0], "mono">) {
  return <Field {...props} mono />
}
