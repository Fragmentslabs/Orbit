import type { ReactElement } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface HintProps {
  /** Rótulo do controle. Vira o tooltip e o nome acessível. */
  label: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  /** Não abre o tooltip — para texto que só precisa dele quando corta. */
  disabled?: boolean
  /** Não injeta `aria-label`: para texto já visível, cujo nome vem do conteúdo. */
  injectName?: boolean
  /** O elemento controlado: um <button>, um <Button>, um <span>. */
  children: ReactElement
}

/**
 * Rótulo de um controle que não tem texto visível.
 *
 * O Orbit não usa `title` nativo: no macOS ele demora cerca de um segundo, não
 * segue o tema e nunca aparece no toque. Este wrapper entrega as três coisas de
 * uma vez — o tooltip do app, o `aria-label` e o nome que o leitor de tela
 * anuncia — sem tocar no visual do elemento, que continua sendo o que o
 * chamador passou.
 *
 * O `aria-label` só é injetado quando o elemento não traz o seu, para não
 * sobrescrever um nome mais específico escrito à mão.
 */
function Hint({ label, side = "top", align, disabled, injectName = true, children }: HintProps) {
  if (!label) return children

  const hasName = Boolean((children.props as { "aria-label"?: string })?.["aria-label"])
  const name = injectName && !hasName ? { "aria-label": label } : {}

  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger render={children} {...name} />
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export { Hint }
