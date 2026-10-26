import { forwardRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * O campo de uma linha do painel do atalho (⇧⌘espaço). É o MESMO nos painéis
 * flutuantes do Computer Use: quem está em outro app e fala com o Orbit vê uma
 * forma só de escrever, seja pelo atalho, seja na conversa que está
 * controlando — não um composer completo de um lado e uma faixa do outro.
 *
 * Só o campo e o que vai ao lado dele (`trailing`); quem usa decide o envio.
 */
export const CompactInput = forwardRef<
  HTMLInputElement,
  {
    value: string
    onChange: (value: string) => void
    /** Enter sem Shift; devolve true quando enviou (o campo é limpo) */
    onSubmit: (value: string) => boolean | void
    placeholder: string
    disabled?: boolean
    /** Ganhou/perdeu o foco (a janela dos painéis só aceita teclado enquanto ele está em uso) */
    onFocusChange?: (focused: boolean) => void
    trailing?: ReactNode
    className?: string
  }
>(function CompactInput({ value, onChange, onSubmit, placeholder, disabled, onFocusChange, trailing, className }, ref) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onPointerDown={() => onFocusChange?.(true)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          if (onSubmit(value)) onChange("")
        }}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={placeholder}
        className="w-full min-w-0 bg-transparent text-[13.5px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
      />
      {trailing}
    </div>
  )
})
